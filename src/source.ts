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

export interface SourceMessage {
  uid: number;
  raw: Buffer;
  messageId: string;
  from: string;
  subject: string;
  isSpam: boolean;
}

type MailboxLock = { release: () => void };

export class Source {
  private readonly client: ImapFlow;
  private lock: MailboxLock | null = null;
  private selectedPath: string | null = null;

  constructor(cfg: ImapAccountConfig) {
    this.client = new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: true,
      auth: {
        user: cfg.email,
        pass: cfg.password,
      },
      logger: false,
    });
  }

  get usable(): boolean {
    return this.client.usable;
  }

  get mailbox(): MailboxObject | false {
    return this.client.mailbox;
  }

  onExists(listener: (data: ExistsEvent) => void): void {
    this.client.on('exists', listener);
  }

  onError(listener: (error: Error) => void): void {
    this.client.on('error', listener);
  }

  onExpunge(listener: (data: ExpungeEvent) => void): void {
    this.client.on('expunge', listener);
  }

  onFlags(listener: (data: FlagsEvent) => void): void {
    this.client.on('flags', listener);
  }

  async connect(): Promise<void> {
    if (this.client.usable) return;
    await this.client.connect();
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
    this.lock = await this.client.getMailboxLock(path);
    this.selectedPath = path;
  }

  async selectInbox(): Promise<void> {
    await this.selectMailbox('INBOX');
  }

  releaseMailbox(): void {
    this.lock?.release();
    this.lock = null;
    this.selectedPath = null;
  }

  releaseInbox(): void {
    this.releaseMailbox();
  }

  async fetchFrom(minUid: number): Promise<SourceMessage[]> {
    const start = Math.max(1, minUid);
    const messages: SourceMessage[] = [];
    for await (const msg of this.client.fetch(`${start}:*`, { source: true }, { uid: true })) {
      messages.push(toSourceMessage(msg));
    }
    return messages;
  }

  async fetchOne(uid: number): Promise<SourceMessage | null> {
    const msg = await this.client.fetchOne(uid, { source: true }, { uid: true });
    if (!msg || !msg.source) return null;
    return toSourceMessage(msg);
  }

  async hasUid(uid: number): Promise<boolean> {
    const msg = await this.client.fetchOne(uid, { uid: true }, { uid: true });
    return Boolean(msg);
  }

  async deleteMessage(uid: number): Promise<void> {
    await this.client.messageDelete(uid, { uid: true });
  }

  async idle(): Promise<void> {
    await this.client.idle();
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
}

function toSourceMessage(msg: FetchMessageObject): SourceMessage {
  const raw = msg.source ?? Buffer.alloc(0);
  const headers = parseHeaders(raw);
  return {
    uid: msg.uid,
    raw,
    messageId: headers.messageId,
    from: headers.from,
    subject: headers.subject,
    isSpam: headers.isSpam,
  };
}

interface ParsedHeaders {
  messageId: string;
  from: string;
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
    subject: decodeMimeWords(map.get('subject') ?? ''),
    isSpam: isSpamMessage(map),
  };
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
