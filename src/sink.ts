// Copyright (c) 2026 Stefan Koelle (https://stefankoelle.de)
// Licensed under the MIT License. See LICENSE file in project root for details.
import { ImapFlow } from 'imapflow';
import type { ImapAccountConfig } from './config.js';

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
            this.client = this.createClient();
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
    await this.ensureConnected();
    // No \Seen: delivered mails must stay unread in Gmail.
    const result = await this.client.append(folder, raw, []);
    if (result === false) {
      throw new Error('Gmail APPEND did not run (connection not ready)');
    }
  }

  async hasMessageId(messageId: string): Promise<boolean> {
    if (!messageId) return false;
    await this.ensureConnected();
    const uids = await this.client.search(
      { header: { 'Message-ID': messageId } },
      { uid: true },
    );
    return Array.isArray(uids) && uids.length > 0;
  }

  async deleteByMessageId(messageId: string): Promise<void> {
    if (!messageId) return;
    await this.ensureConnected();
    const uids = await this.client.search(
      { header: { 'Message-ID': messageId } },
      { uid: true },
    );
    if (Array.isArray(uids) && uids.length > 0) {
      await this.client.messageDelete(uids, { uid: true });
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
