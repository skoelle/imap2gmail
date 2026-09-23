// Copyright (c) 2026 Stefan Koelle (https://stefankoelle.de)
// Licensed under the MIT License. See LICENSE file in project root for details.
import type { Ntfy } from './ntfy.js';
import type { Sink } from './sink.js';
import type { Source, SourceMessage } from './source.js';
import type { RelayState, StateStore } from './state.js';

export class Relay {
  private busy = false;
  private rerun = false;

  constructor(
    private readonly source: Source,
    private readonly sink: Sink,
    private readonly state: StateStore,
    private readonly ntfy: Ntfy,
  ) {}

  async catchUp(): Promise<void> {
    if (this.busy) {
      this.rerun = true;
      return;
    }
    this.busy = true;
    try {
      do {
        this.rerun = false;
        await this.runOnce();
      } while (this.rerun);
    } finally {
      this.busy = false;
    }
  }

  private async runOnce(): Promise<void> {
    await this.source.ensureConnected();
    await this.sink.ensureConnected();
    await this.source.selectInbox();

    const mailbox = this.source.mailbox;
    if (!mailbox) {
      throw new Error('Source mailbox not selected');
    }
    const uidValidity = Number(mailbox.uidValidity as bigint | number);
    let state = this.state.load();

    if (state.uidValidity !== uidValidity) {
      if (state.lastUid > 0 || state.uidValidity > 0) {
        console.warn(
          `[relay] uidValidity changed (${state.uidValidity} → ${uidValidity}); resetting lastUid`,
        );
      }
      state = {
        uidValidity,
        lastUid: 0,
        pendingUid: state.pendingUid,
      };
      this.state.save(state);
    }

    if (state.pendingUid !== undefined) {
      await this.resolvePending(state);
      state = this.state.load();
    }

    const messages = await this.source.fetchFrom(state.lastUid + 1);
    for (const message of messages) {
      await this.processOne(message, uidValidity);
    }
  }

  private async resolvePending(state: RelayState): Promise<void> {
    const pendingUid = state.pendingUid;
    if (pendingUid === undefined) return;

    const stillInSource = await this.source.hasUid(pendingUid);
    if (!stillInSource) {
      this.state.save({
        ...state,
        lastUid: Math.max(state.lastUid, pendingUid),
        pendingUid: undefined,
      });
      console.log(`[relay] pending uid ${pendingUid} already deleted from source`);
      return;
    }

    const message = await this.source.fetchOne(pendingUid);
    if (!message) {
      this.state.save({ ...state, pendingUid: undefined });
      return;
    }

    const inGmail = await this.sink.hasMessageId(message.messageId);
    if (inGmail) {
      await this.source.deleteMessage(message.uid);
      const next: RelayState = {
        ...state,
        lastUid: Math.max(state.lastUid, pendingUid),
        pendingUid: undefined,
      };
      this.state.save(next);
      await this.ntfy.notify(message.from, message.subject);
      console.log(`[relay] recovered pending uid ${pendingUid} (was already in Gmail)`);
      return;
    }

    this.state.save({ ...state, pendingUid: undefined });
    console.log(`[relay] pending uid ${pendingUid} not in Gmail; will re-process`);
  }

  private async processOne(message: SourceMessage, uidValidity: number): Promise<void> {
    const before = this.state.load();
    const marked: RelayState = {
      uidValidity,
      lastUid: before.lastUid,
      pendingUid: message.uid,
    };
    this.state.save(marked);

    try {
      await this.sink.append(message.raw);
    } catch (err) {
      this.state.save({ uidValidity, lastUid: before.lastUid, pendingUid: undefined });
      throw new Error(
        `Gmail append failed for uid ${message.uid}: ${err instanceof Error ? err.message : err}`,
      );
    }

    try {
      await this.source.deleteMessage(message.uid);
    } catch (err) {
      try {
        await this.sink.deleteByMessageId(message.messageId);
      } catch (rollbackErr) {
        console.error(
          `[relay] Gmail rollback failed for uid ${message.uid}:`,
          rollbackErr instanceof Error ? rollbackErr.message : rollbackErr,
        );
      }
      this.state.save({ uidValidity, lastUid: before.lastUid, pendingUid: undefined });
      throw new Error(
        `Source delete failed for uid ${message.uid}: ${err instanceof Error ? err.message : err}`,
      );
    }

    const after: RelayState = {
      uidValidity,
      lastUid: Math.max(before.lastUid, message.uid),
      pendingUid: undefined,
    };
    this.state.save(after);
    console.log(`[relay] delivered uid=${message.uid} subject="${message.subject}"`);
    await this.ntfy.notify(message.from, message.subject);
  }
}
