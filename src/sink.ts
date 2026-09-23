// Copyright (c) 2026 Stefan Koelle (https://stefankoelle.de)
// Licensed under the MIT License. See LICENSE file in project root for details.
import { ImapFlow } from 'imapflow';
import type { ImapAccountConfig } from './config.js';

export class Sink {
  private readonly client: ImapFlow;

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

  async connect(): Promise<void> {
    if (!this.client.usable) {
      await this.client.connect();
    }
    if (this.client.mailbox === false || this.client.mailbox.path !== 'INBOX') {
      await this.client.mailboxOpen('INBOX');
    }
  }

  async ensureConnected(): Promise<void> {
    await this.connect();
  }

  async append(raw: Buffer): Promise<void> {
    await this.ensureConnected();
    const result = await this.client.append('INBOX', raw, ['\\Seen']);
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
}
