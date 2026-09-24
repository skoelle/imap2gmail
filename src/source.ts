// Copyright (c) 2026 Stefan Koelle (https://stefankoelle.de)
// Licensed under the MIT License. See LICENSE file in project root for details.
import {
  ImapFlow,
  type ExistsEvent,
  type ExpungeEvent,
  type FetchMessageObject,
  type FlagsEvent,
  type MailboxObject,
} from 'imapflow';
import type { ImapAccountConfig } from './config.js';
import { isConnectionGone } from './errors.js';

export interface SourceMessage {
  uid: number;
  raw: Buffer;
  messageId: string;
  from: string;
  to: string;
  subject: string;
  isSpam: boolean;
}

type MailboxLock = { release: () => void };

type ExistsListener = (data: ExistsEvent) => void;
type ErrorListener = (error: Error) => void;
type ExpungeListener = (data: ExpungeEvent) => void;
type FlagsListener = (data: FlagsEvent) => void;

export class Source {
  private readonly cfg: ImapAccountConfig;
  private client: ImapFlow;
  private lock: MailboxLock | null = null;
  private selectedPath: string | null = null;
  private connecting: Promise<void> | null = null;
  private clientConnectCalled = false;
  private readonly existsListeners: ExistsListener[] = [];
  private readonly errorListeners: ErrorListener[] = [];
  private readonly expungeListeners: ExpungeListener[] = [];
  private readonly flagsListeners: FlagsListener[] = [];

  constructor(cfg: ImapAccountConfig) {
    this.cfg = cfg;
    this.client = this.createClient();
  }

  get usable(): boolean {
    return this.client.usable;
  }

  get mailbox(): MailboxObject | false {
    return this.client.mailbox;
  }

  onExists(listener: ExistsListener): void {
    this.existsListeners.push(listener);
    this.client.on('exists', listener);
  }

  onError(listener: ErrorListener): void {
    this.errorListeners.push(listener);
    this.client.on('error', listener);
  }

  onExpunge(listener: ExpungeListener): void {
    this.expungeListeners.push(listener);
    this.client.on('expunge', listener);
  }

  onFlags(listener: FlagsListener): void {
    this.flagsListeners.push(listener);
    this.client.on('flags', listener);
  }

  async connect(): Promise<void> {
    if (this.client.usable) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        // imapflow is single-use: after any disconnect, build a fresh instance.
        if (!this.client.usable) {
          if (this.clientConnectCalled) {
            this.resetMailbox();
            this.replaceClient();
          }
          this.clientConnectCalled = true;
          await this.client.connect();
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

  async selectMailbox(path: string): Promise<void> {
    await this.ensureConnected();
    if (this.lock && this.selectedPath === path) return;
    if (this.lock) {
      this.lock.release();
      this.lock = null;
      this.selectedPath = null;
    }
    this.lock = await this.run((client) => client.getMailboxLock(path));
    this.selectedPath = path;
  }

  async selectInbox(): Promise<void> {
    await this.selectMailbox('INBOX');
  }

  releaseMailbox(): void {
    const lock = this.lock;
    this.lock = null;
    this.selectedPath = null;
    try {
      lock?.release();
    } catch {
      // ignore release on dead connection
    }
  }

  releaseInbox(): void {
    this.releaseMailbox();
  }

  /** Fetch messages from `minUid`; optional `limit` bounds the batch (memory). */
  async fetchFrom(minUid: number, limit?: number): Promise<SourceMessage[]> {
    const start = Math.max(1, minUid);
    return await this.run(async (client) => {
      const messages: SourceMessage[] = [];
      // imapflow handles an early break: its generator finally drains backpressure.
      for await (const m of client.fetch(`${start}:*`, { source: true }, { uid: true })) {
        messages.push(toSourceMessage(m));
        if (limit !== undefined && messages.length >= limit) break;
      }
      return messages;
    });
  }

  async fetchOne(uid: number): Promise<SourceMessage | null> {
    const msg = await this.run((client) =>
      client.fetchOne(uid, { source: true }, { uid: true }),
    );
    if (!msg || !msg.source) return null;
    return toSourceMessage(msg);
  }

  async hasUid(uid: number): Promise<boolean> {
    const msg = await this.run((client) => client.fetchOne(uid, { uid: true }, { uid: true }));
    return Boolean(msg);
  }

  async deleteMessage(uid: number): Promise<void> {
    await this.run((client) => client.messageDelete(uid, { uid: true }));
  }

  async idle(timeoutMs: number): Promise<void> {
    const idlePromise = this.client.idle();
    // If the timeout wins the race, close() below rejects this promise; keep it handled.
    void idlePromise.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        idlePromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('IDLE timeout')), timeoutMs);
        }),
      ]);
    } catch (err) {
      if (err instanceof Error && err.message === 'IDLE timeout') {
        // Abandoning idle() alone leaves the session running and can make the next
        // idle() return instantly in a tight loop - rebuild to break it for real.
        console.warn(`[source] IDLE exceeded ${timeoutMs}ms, rebuilding client`);
        this.replaceClient();
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async logout(): Promise<void> {
    try {
      this.releaseMailbox();
      if (this.client.usable) {
        await this.client.logout();
      }
    } catch {
      // ignore shutdown errors
    }
  }

  private createClient(): ImapFlow {
    const client = new ImapFlow({
      host: this.cfg.host,
      port: this.cfg.port,
      secure: true,
      auth: {
        user: this.cfg.email,
        pass: this.cfg.password,
      },
      logger: false,
    });
    for (const listener of this.existsListeners) client.on('exists', listener);
    for (const listener of this.errorListeners) client.on('error', listener);
    for (const listener of this.expungeListeners) client.on('expunge', listener);
    for (const listener of this.flagsListeners) client.on('flags', listener);
    return client;
  }

  private replaceClient(): void {
    this.releaseMailbox();
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

  private resetMailbox(): void {
    this.releaseMailbox();
  }

  /** Run one IMAP op; on gone connection rebuild the client and retry once. */
  private async run<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    try {
      await this.ensureConnected();
      return await fn(this.client);
    } catch (err) {
      if (!isConnectionGone(err)) throw err;
      console.warn(
        '[source] connection lost, rebuilding client:',
        err instanceof Error ? err.message : err,
      );
      this.replaceClient();
      await this.ensureConnected();
      return await fn(this.client);
    }
  }
}

function toSourceMessage(msg: FetchMessageObject): SourceMessage {
  const raw = msg.source ?? Buffer.alloc(0);
  const headers = parseHeaders(raw);
  return {
    uid: msg.uid,
    raw,
    messageId: headers.messageId,
    from: headers.from,
    to: headers.to,
    subject: headers.subject,
    isSpam: headers.isSpam,
  };
}

interface ParsedHeaders {
  messageId: string;
  from: string;
  to: string;
  subject: string;
  isSpam: boolean;
}

function parseHeaders(raw: Buffer): ParsedHeaders {
  const text = raw.toString('utf8');
  const sep = text.indexOf('\r\n\r\n');
  const headerBlock = sep >= 0 ? text.slice(0, sep) : text;
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  const map = new Map<string, string>();
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!map.has(name)) map.set(name, value);
  }
  return {
    messageId: decodeMimeWords(stripAngles(map.get('message-id') ?? '')),
    from: decodeMimeWords(map.get('from') ?? ''),
    to: firstRecipient(map),
    subject: decodeMimeWords(map.get('subject') ?? ''),
    isSpam: isSpamMessage(map),
  };
}

/** Prefer delivery headers over To; first address only. */
function firstRecipient(headers: Map<string, string>): string {
  for (const name of ['delivered-to', 'x-original-to', 'x-forwarded-to', 'to']) {
    const raw = headers.get(name);
    if (!raw) continue;
    const decoded = decodeMimeWords(raw);
    const first = decoded.split(',')[0]?.trim() ?? '';
    if (first) return first;
  }
  return '';
}

function isSpamMessage(headers: Map<string, string>): boolean {
  const flag = (headers.get('x-spam-flag') ?? '').toLowerCase();
  if (flag === 'yes' || flag === 'true') return true;
  const status = (headers.get('x-spam-status') ?? '').toLowerCase();
  if (status.startsWith('yes')) return true;
  const ui = (headers.get('x-ui-filterresults') ?? '').toLowerCase();
  if (ui.includes('junk') || ui.includes('spam')) return true;
  return false;
}

function stripAngles(value: string): string {
  return value.replace(/^<|>$/g, '');
}

function decodeMimeWords(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_match, charset: string, encoding: string, text: string) => {
      try {
        const cs = charset.toLowerCase();
        const utf8 = cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii' || cs === 'ascii';
        if (encoding.toUpperCase() === 'B') {
          const buf = Buffer.from(text, 'base64');
          return utf8 ? buf.toString('utf8') : buf.toString('latin1');
        }
        const bytes = text
          .replace(/_/g, ' ')
          .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
            String.fromCharCode(Number.parseInt(hex, 16)),
          );
        const buf = Buffer.from(bytes, 'latin1');
        return utf8 ? buf.toString('utf8') : buf.toString('latin1');
      } catch {
        return text;
      }
    },
  );
}
