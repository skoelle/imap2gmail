// Copyright (c) 2026 Stefan Koelle (https://stefankoelle.de)
// Licensed under the MIT License. See LICENSE file in project root for details.
import type { SpamAction } from './config.js';
import type { Ntfy } from './ntfy.js';
import type { Sink } from './sink.js';
import type { Source, SourceMessage } from './source.js';
import type { FailedEntry, RelayState, StateStore } from './state.js';

const MAX_FAIL_ATTEMPTS = 3;

export class Relay {
  private busy = false;
  private rerun = false;

  constructor(
    private readonly source: Source,
    private readonly sink: Sink,
    private readonly state: StateStore,
    private readonly ntfy: Ntfy,
    private readonly spamAction: SpamAction = 'gmail-spam',
    private readonly noticeFrom = 'imap2gmail@localhost',
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
        failed: {},
      };
      this.state.save(state);
    }

    if (state.pendingUid !== undefined) {
      await this.resolvePending(state);
      state = this.state.load();
    }

    await this.retryFailed(uidValidity);

    const messages = await this.source.fetchFrom(state.lastUid + 1);
    for (const message of messages) {
      try {
        await this.processOne(message, uidValidity);
      } catch (err) {
        await this.recordFailure(message, uidValidity, err);
      }
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

    if (message.isSpam && this.spamAction === 'skip') {
      await this.source.deleteMessage(message.uid);
      const next: RelayState = {
        ...state,
        lastUid: Math.max(state.lastUid, pendingUid),
        pendingUid: undefined,
      };
      this.state.save(next);
      console.log(`[relay] skipped spam uid=${pendingUid} (deleted from source)`);
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
      this.clearFailed(message.uid);
      await this.ntfy.notify(message.from, message.subject);
      console.log(`[relay] recovered pending uid ${pendingUid} (was already in Gmail)`);
      return;
    }

    this.state.save({ ...state, pendingUid: undefined });
    console.log(`[relay] pending uid ${pendingUid} not in Gmail; will re-process`);
  }

  private async retryFailed(uidValidity: number): Promise<void> {
    const state = this.state.load();
    const failed = state.failed ?? {};
    const uids = Object.keys(failed)
      .map(Number)
      .filter((uid) => Number.isFinite(uid))
      .sort((a, b) => a - b);
    if (uids.length === 0) return;

    for (const uid of uids) {
      const message = await this.source.fetchOne(uid);
      if (!message) {
        this.clearFailed(uid);
        console.log(`[relay] failed uid ${uid} no longer on source; dropping`);
        continue;
      }

      try {
        if (message.isSpam && this.spamAction === 'skip') {
          await this.source.deleteMessage(uid);
          this.clearFailed(uid);
          this.advanceLastUid(uidValidity, uid);
          console.log(`[relay] skipped spam uid=${uid} on retry`);
          continue;
        }

        if (message.messageId && (await this.sink.hasMessageId(message.messageId))) {
          await this.source.deleteMessage(uid);
          this.clearFailed(uid);
          this.advanceLastUid(uidValidity, uid);
          await this.ntfy.notify(message.from, message.subject);
          console.log(`[relay] failed uid ${uid} already in Gmail; cleaned up`);
          continue;
        }

        const folder = this.gmailFolderFor(message);
        await this.sink.append(message.raw, folder);
        await this.source.deleteMessage(uid);
        this.clearFailed(uid);
        this.advanceLastUid(uidValidity, uid);
        const spamNote = message.isSpam ? ' (spam)' : '';
        console.log(
          `[relay] delivered previously failed uid=${uid}${spamNote} folder=${folder} subject="${message.subject}"`,
        );
        if (!(message.isSpam && this.spamAction !== 'inbox')) {
          await this.ntfy.notify(message.from, message.subject);
        }
      } catch (err) {
        await this.recordFailure(message, uidValidity, err);
      }
    }
  }

  private gmailFolderFor(message: SourceMessage): string {
    if (!message.isSpam || this.spamAction === 'inbox') return 'INBOX';
    return '[Gmail]/Spam';
  }

  private async processOne(message: SourceMessage, uidValidity: number): Promise<void> {
    const before = this.state.load();

    if (message.isSpam && this.spamAction === 'skip') {
      const markedSkip: RelayState = {
        uidValidity,
        lastUid: before.lastUid,
        pendingUid: message.uid,
        failed: before.failed,
      };
      this.state.save(markedSkip);
      await this.source.deleteMessage(message.uid);
      const afterSkip: RelayState = {
        uidValidity,
        lastUid: Math.max(before.lastUid, message.uid),
        pendingUid: undefined,
        failed: before.failed,
      };
      this.state.save(afterSkip);
      this.clearFailed(message.uid);
      console.log(`[relay] skipped spam uid=${message.uid} subject="${message.subject}"`);
      return;
    }

    const marked: RelayState = {
      uidValidity,
      lastUid: before.lastUid,
      pendingUid: message.uid,
      failed: before.failed,
    };
    this.state.save(marked);

    const folder = this.gmailFolderFor(message);
    try {
      await this.sink.append(message.raw, folder);
    } catch (err) {
      throw new Error(
        `Gmail append failed for uid ${message.uid}: ${err instanceof Error ? err.message : err}`,
      );
    }

    try {
      await this.source.deleteMessage(message.uid);
    } catch (err) {
      let rollbackOk = false;
      try {
        await this.sink.deleteByMessageId(message.messageId);
        rollbackOk = true;
      } catch (rollbackErr) {
        console.error(
          `[relay] Gmail rollback failed for uid ${message.uid}:`,
          rollbackErr instanceof Error ? rollbackErr.message : rollbackErr,
        );
      }
      if (!rollbackOk) {
        await this.recordFailure(message, uidValidity, err, { keepPending: true });
        return;
      }
      throw new Error(
        `Source delete failed for uid ${message.uid}: ${err instanceof Error ? err.message : err}`,
      );
    }

    const after: RelayState = {
      uidValidity,
      lastUid: Math.max(before.lastUid, message.uid),
      pendingUid: undefined,
      failed: before.failed,
    };
    this.state.save(after);
    this.clearFailed(message.uid);
    const spamNote = message.isSpam ? ' (spam)' : '';
    console.log(
      `[relay] delivered uid=${message.uid}${spamNote} folder=${folder} subject="${message.subject}"`,
    );
    if (!(message.isSpam && this.spamAction !== 'inbox')) {
      await this.ntfy.notify(message.from, message.subject);
    }
  }

  private async recordFailure(
    message: SourceMessage,
    uidValidity: number,
    error: unknown,
    opts: { keepPending?: boolean } = {},
  ): Promise<void> {
    const errMsg = error instanceof Error ? error.message : String(error);
    const state = this.state.load();
    const failed: Record<string, FailedEntry> = { ...(state.failed ?? {}) };
    const key = String(message.uid);
    const prev = failed[key] ?? { attempts: 0, reported: false };
    const attempts = prev.attempts + 1;
    let reported = prev.reported;

    if (attempts >= MAX_FAIL_ATTEMPTS && !reported) {
      reported = await this.sendFailureNotice(message, attempts, errMsg);
    }

    failed[key] = { attempts, reported };
    this.state.save({
      uidValidity,
      lastUid: Math.max(state.lastUid, message.uid),
      pendingUid: opts.keepPending ? message.uid : undefined,
      failed,
    });
    console.error(
      `[relay] delivery failed uid=${message.uid} attempt=${attempts}/${MAX_FAIL_ATTEMPTS}: ${errMsg}`,
    );
  }

  private async sendFailureNotice(
    message: SourceMessage,
    attempts: number,
    error: string,
  ): Promise<boolean> {
    try {
      const subject = message.subject || '(no subject)';
      const lines = [
        `From: ${this.noticeFrom}`,
        `To: ${this.noticeFrom}`,
        `Subject: [imap2gmail] not delivered: ${subject}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <imap2gmail-fail-${message.uid}-${Date.now()}@imap2gmail>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'imap2gmail could not deliver a message.',
        '',
        `UID: ${message.uid}`,
        `From: ${message.from || '(unknown)'}`,
        `Subject: ${subject}`,
        `Attempts: ${attempts}`,
        `Error: ${error}`,
        '',
        'The message stays on the source IMAP server and will be retried.',
        'This notice is sent only once per message.',
        '',
      ];
      const raw = Buffer.from(lines.join('\r\n'), 'utf8');
      await this.sink.append(raw, 'INBOX');
      console.log(`[relay] one-time failure notice for uid=${message.uid} appended to Gmail`);
      return true;
    } catch (err) {
      console.error(
        `[relay] failure notice failed for uid=${message.uid}:`,
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  private clearFailed(uid: number): void {
    const state = this.state.load();
    const failed = { ...(state.failed ?? {}) };
    const key = String(uid);
    if (!(key in failed)) return;
    delete failed[key];
    this.state.save({ ...state, failed });
  }

  private advanceLastUid(uidValidity: number, uid: number): void {
    const state = this.state.load();
    this.state.save({
      ...state,
      uidValidity,
      lastUid: Math.max(state.lastUid, uid),
      pendingUid: undefined,
    });
  }
}
