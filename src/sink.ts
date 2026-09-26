// Copyright (c) 2026 Stefan Koelle (https://stefankoelle.de)
// Licensed under the MIT License. See LICENSE file in project root for details.
import { ImapFlow } from 'imapflow';
import type { ImapAccountConfig } from './config.js';
import { isConnectionGone } from './errors.js';

export class Sink {
  private readonly cfg: ImapAccountConfig;
  private client: ImapFlow;
  private connecting: Promise<void> | null = null;
  private clientConnectCalled = false;
  private archivePath: string | null = null;

  constructor(cfg: ImapAccountConfig) {
    this.cfg = cfg;
    this.client = this.createClient();
  }

  get usable(): boolean {
    return this.client.usable;
  }

  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        // imapflow is single-use: after any disconnect, build a fresh instance.
        if (!this.client.usable) {
          if (this.clientConnectCalled) {
            this.replaceClient();
          }
          this.clientConnectCalled = true;
          await this.client.connect();
          // Only select a default mailbox after (re)connect; folder-scoped ops
          // select their own mailbox and must not be forced back to INBOX.
          await this.client.mailboxOpen('INBOX');
        } else if (this.client.mailbox === false) {
          await this.client.mailboxOpen('INBOX');
        }
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  async ensureConnected(): Promise<void> {
    await this.connect();
  }

  async append(raw: Buffer, folder = 'INBOX'): Promise<void> {
    const result = await this.run((client) => client.append(folder, raw, []));
    if (result === false) {
      throw new Error('Gmail APPEND did not run (connection not ready)');
    }
  }

  /**
   * Resolve Gmail's All Mail folder. Gmail localizes and prefixes the name
   * (`[Gmail]/All Mail` vs `[Google Mail]/…`, de/en), so we trust the SPECIAL-USE
   * `\All` attribute from LIST instead of guessing. Result is cached; the
   * configured locale name is the fallback if discovery finds no match.
   */
  async archiveFolder(fallback: string): Promise<string> {
    if (this.archivePath) return this.archivePath;
    try {
      const folders = await this.run((client) => client.list());
      const all = folders.find(
        (entry) =>
          entry.specialUse === '\\All' ||
          entry.flags.has('\\All') ||
          entry.flags.has('\\AllMail'),
      );
      if (all) {
        this.archivePath = all.path;
        console.log(`[sink] archive folder resolved via special-use: "${all.path}"`);
        return all.path;
      }
      const listed = folders.some((entry) => entry.path === fallback);
      console.warn(
        `[sink] no \\All folder in LIST; ${listed ? 'falling back to configured name' : 'configured name not listed, will still try'} "${fallback}"`,
      );
      if (!listed) {
        console.warn(`[sink] available folders: ${folders.map((e) => e.path).join(', ')}`);
      }
      this.archivePath = fallback;
      return fallback;
    } catch (err) {
      console.warn(
        '[sink] archive folder lookup failed:',
        err instanceof Error ? err.message : err,
      );
      return fallback; // not cached: retry discovery on next call
    }
  }

  /** Search only the target folder: archived/spam mail is not visible in INBOX. */
  async hasMessageId(messageId: string, folder = 'INBOX'): Promise<boolean> {
    if (!messageId) return false;
    const uids = await this.run(async (client) => {
      await this.openFolder(client, folder);
      return await client.search({ header: { 'Message-ID': messageId } }, { uid: true });
    });
    return Array.isArray(uids) && uids.length > 0;
  }

  async deleteByMessageId(messageId: string, folder = 'INBOX'): Promise<void> {
    if (!messageId) return;
    await this.run(async (client) => {
      await this.openFolder(client, folder);
      const uids = await client.search(
        { header: { 'Message-ID': messageId } },
        { uid: true },
      );
      if (Array.isArray(uids) && uids.length > 0) {
        await client.messageDelete(uids, { uid: true });
      }
    });
  }

  private async openFolder(client: ImapFlow, folder: string): Promise<void> {
    if (client.mailbox === false || client.mailbox.path !== folder) {
      await client.mailboxOpen(folder);
    }
  }

  async logout(): Promise<void> {
    try {
      if (this.client.usable) {
        await this.client.logout();
      }
    } catch {
      // ignore shutdown errors
    }
  }

  /** Run one IMAP op; on gone connection rebuild the client and retry once. */
  private async run<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    try {
      await this.ensureConnected();
      return await fn(this.client);
    } catch (err) {
      if (!isConnectionGone(err)) throw err;
      console.warn(
        '[sink] connection lost, rebuilding client:',
        err instanceof Error ? err.message : err,
      );
      this.replaceClient();
      await this.ensureConnected();
      return await fn(this.client);
    }
  }

  private replaceClient(): void {
    const old = this.client;
    this.client = this.createClient();
    this.clientConnectCalled = false;
    this.connecting = null;
    try {
      old.close();
    } catch {
      // ignore close on already dead client
    }
  }

  private createClient(): ImapFlow {
    return new ImapFlow({
      host: this.cfg.host,
      port: this.cfg.port,
      secure: true,
      auth: {
        user: this.cfg.email,
        pass: this.cfg.password,
      },
      logger: false,
    });
  }
}
