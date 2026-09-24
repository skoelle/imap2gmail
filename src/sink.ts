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
        }
        if (this.client.mailbox === false || this.client.mailbox.path !== 'INBOX') {
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

  async hasMessageId(messageId: string): Promise<boolean> {
    if (!messageId) return false;
    const uids = await this.run((client) =>
      client.search({ header: { 'Message-ID': messageId } }, { uid: true }),
    );
    return Array.isArray(uids) && uids.length > 0;
  }

  async deleteByMessageId(messageId: string): Promise<void> {
    if (!messageId) return;
    const uids = await this.run((client) =>
      client.search({ header: { 'Message-ID': messageId } }, { uid: true }),
    );
    if (Array.isArray(uids) && uids.length > 0) {
      await this.run((client) => client.messageDelete(uids, { uid: true }));
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
