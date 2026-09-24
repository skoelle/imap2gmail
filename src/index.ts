// Copyright (c) 2026 Stefan Koelle (https://stefankoelle.de)
// Licensed under the MIT License. See LICENSE file in project root for details.
import { loadConfig } from './config.js';
import { Ntfy } from './ntfy.js';
import { Relay } from './relay.js';
import { Sink } from './sink.js';
import { Source } from './source.js';
import { StateStore } from './state.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const source = new Source(config.source);
  const sink = new Sink(config.gmail);
  const state = new StateStore(config.stateFile);
  const ntfy = new Ntfy(config.ntfyTopicUrl, config.ntfyBlacklist);
  const relay = new Relay(
    source,
    sink,
    state,
    ntfy,
    config.spamAction,
    config.gmail.email,
    config.sourceSpamFolder,
  );

  let shuttingDown = false;

  const trigger = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    try {
      await relay.catchUp();
    } catch (err) {
      console.error(`[main] catch-up failed (${reason}):`, err instanceof Error ? err.message : err);
    }
  };

  console.log('[main] connecting to source and Gmail…');
  await source.connect();
  await sink.connect();

  source.onExists(() => {
    void trigger('exists');
  });
  source.onError((err) => {
    console.error('[source] error:', err.message);
  });

  const pollMs = config.fallbackPollSeconds * 1000;
  const pollTimer = setInterval(() => {
    void trigger('fallback-poll');
  }, pollMs);

  await trigger('startup');

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[main] ${signal} received, shutting down…`);
    clearInterval(pollTimer);
    await sleep(100);
    await Promise.allSettled([source.logout(), sink.logout()]);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  console.log(
    `[main] running (poll every ${config.fallbackPollSeconds}s, spam=${config.spamAction}, sourceSpam=${config.sourceSpamFolder || 'off'}, ntfy ${ntfy.enabled ? 'on' : 'off'}${config.ntfyBlacklist.length ? `, blacklist=${config.ntfyBlacklist.length}` : ''})`,
  );

  const backoffMs = [3000, 5000, 15000, 60000];
  let reconnectAttempt = 0;

  while (!shuttingDown) {
    try {
      await source.idle();
      reconnectAttempt = 0;
    } catch (err) {
      if (shuttingDown) break;
      console.error('[main] idle/reconnect error:', err instanceof Error ? err.message : err);
      await sleep(backoffMs[Math.min(reconnectAttempt, backoffMs.length - 1)]);
      try {
        source.releaseInbox();
        await source.ensureConnected();
        reconnectAttempt = 0;
        await trigger('after-reconnect');
      } catch (reconnectErr) {
        reconnectAttempt += 1;
        const wait = backoffMs[Math.min(reconnectAttempt, backoffMs.length - 1)];
        console.error(
          `[main] reconnect failed (attempt ${reconnectAttempt}):`,
          reconnectErr instanceof Error ? reconnectErr.message : reconnectErr,
        );
        await sleep(wait);
      }
      continue;
    }
    if (!shuttingDown) {
      await trigger('idle-return');
      await sleep(500);
    }
  }
}

main().catch((err) => {
  console.error('[main] fatal:', err);
  process.exit(1);
});
