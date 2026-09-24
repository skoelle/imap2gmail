// Copyright (c) 2026 Stefan Koelle (https://stefankoelle.de)
// Licensed under the MIT License. See LICENSE file in project root for details.
import type { ArchiveRule, SpamAction } from './config.js';
import { isConnectionGone } from './errors.js';
import type { Ntfy } from './ntfy.js';
import type { Sink } from './sink.js';
import type { Source, SourceMessage } from './source.js';
import type { FailedEntry, FolderState, StateStore } from './state.js';

const MAX_FAIL_ATTEMPTS = 3;

type FolderKind = 'inbox' | 'spam';

export class Relay {
  private busy = false;
  private rerun = false;
  private connectionLost = false;

  constructor(
    private readonly source: Source,
    private readonly sink: Sink,
    private readonly state: StateStore,
    private readonly ntfy: Ntfy,
    private readonly spamAction: SpamAction = 'gmail-spam',
    private readonly noticeFrom = 'imap2gmail@localhost',
    private readonly sourceSpamFolder = '',
    private readonly archiveRules: ArchiveRule[] = [],
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
    this.connectionLost = false;
    await this.source.ensureConnected();
    await this.sink.ensureConnected();

    await this.processFolder('inbox');

    if (this.sourceSpamFolder) {
      try {
        await this.processFolder('spam');
      } catch (err) {
        console.error(
          `[relay] source spam folder "${this.sourceSpamFolder}" failed:`,
          err instanceof Error ? err.message : err,
        );
        if (isConnectionGone(err)) this.connectionLost = true;
      }
      await this.source.selectInbox();
    }

    // Surface dead IMAP links so catch-up fails and the reconnect alert can fire.
    if (this.connectionLost) {
      this.connectionLost = false;
      throw new Error('IMAP connection lost during catch-up');
    }
  }

  private mailboxPath(kind: FolderKind): string {
    return kind === 'spam' ? this.sourceSpamFolder : 'INBOX';
  }

  private loadFolder(kind: FolderKind): FolderState {
    const state = this.state.load();
    if (kind === 'spam') {
      return state.spam ?? { uidValidity: 0, lastUid: 0, failed: {} };
    }
    return {
      uidValidity: state.uidValidity,
      lastUid: state.lastUid,
      pendingUid: state.pendingUid,
      failed: state.failed,
    };
  }

  private saveFolder(kind: FolderKind, folder: FolderState): void {
    const state = this.state.load();
    if (kind === 'spam') {
      this.state.save({ ...state, spam: folder });
      return;
    }
    this.state.save({
      ...state,
      uidValidity: folder.uidValidity,
      lastUid: folder.lastUid,
      pendingUid: folder.pendingUid,
      failed: folder.failed,
    });
  }

  /** Mails from the source spam folder always target Gmail Spam (or skip). */
  private isSourceSpam(kind: FolderKind): boolean {
    return kind === 'spam';
  }

  /** First matching archive rule wins over spam and INBOX. */
  private isArchived(message: SourceMessage): boolean {
    if (this.archiveRules.length === 0) return false;
    const subject = message.subject.toLowerCase();
    const from = message.from.toLowerCase();
    return this.archiveRules.some((rule) => {
      if (rule.subject !== undefined && !subject.includes(rule.subject.toLowerCase())) {
        return false;
      }
      if (rule.from !== undefined && !from.includes(rule.from.toLowerCase())) {
        return false;
      }
      return true;
    });
  }

  private shouldNotify(kind: FolderKind, message: SourceMessage): boolean {
    if (this.isArchived(message)) return false;
    if (kind === 'spam') return false;
    if (message.isSpam && this.spamAction !== 'inbox') return false;
    return true;
  }

  private async processFolder(kind: FolderKind): Promise<void> {
    await this.source.selectMailbox(this.mailboxPath(kind));

    const mailbox = this.source.mailbox;
    if (!mailbox) {
      throw new Error(`Source mailbox not selected: ${this.mailboxPath(kind)}`);
    }
    const uidValidity = Number(mailbox.uidValidity as bigint | number);
    let folder = this.loadFolder(kind);

    if (folder.uidValidity !== uidValidity) {
      if (folder.lastUid > 0 || folder.uidValidity > 0) {
        console.warn(
          `[relay] ${kind} uidValidity changed (${folder.uidValidity} → ${uidValidity}); resetting lastUid`,
        );
      }
      folder = {
        uidValidity,
        lastUid: 0,
        pendingUid: folder.pendingUid,
        failed: {},
      };
      this.saveFolder(kind, folder);
    }

    if (folder.pendingUid !== undefined) {
      await this.resolvePending(kind);
      folder = this.loadFolder(kind);
    }

    await this.retryFailed(kind, uidValidity);

    const messages = await this.source.fetchFrom(folder.lastUid + 1);
    for (const message of messages) {
      try {
        await this.processOne(kind, message, uidValidity);
      } catch (err) {
        await this.recordFailure(kind, message, uidValidity, err);
      }
    }
  }

  private async resolvePending(kind: FolderKind): Promise<void> {
    let folder = this.loadFolder(kind);
    const pendingUid = folder.pendingUid;
    if (pendingUid === undefined) return;

    const stillInSource = await this.source.hasUid(pendingUid);
    if (!stillInSource) {
      this.saveFolder(kind, {
        ...folder,
        lastUid: Math.max(folder.lastUid, pendingUid),
        pendingUid: undefined,
      });
      console.log(`[relay] ${kind} pending uid ${pendingUid} already deleted from source`);
      return;
    }

    const message = await this.source.fetchOne(pendingUid);
    if (!message) {
      this.saveFolder(kind, { ...folder, pendingUid: undefined });
      return;
    }

    const archived = this.isArchived(message);
    const treatAsSpam = !archived && (this.isSourceSpam(kind) || message.isSpam);
    if (treatAsSpam && this.spamAction === 'skip') {
      await this.source.deleteMessage(message.uid);
      this.saveFolder(kind, {
        ...folder,
        lastUid: Math.max(folder.lastUid, pendingUid),
        pendingUid: undefined,
      });
      this.clearFailed(kind, message.uid);
      console.log(`[relay] ${kind} skipped spam uid=${pendingUid} (deleted from source)`);
      return;
    }

    const inGmail = await this.sink.hasMessageId(message.messageId);
    if (inGmail) {
      await this.source.deleteMessage(message.uid);
      this.saveFolder(kind, {
        ...folder,
        lastUid: Math.max(folder.lastUid, pendingUid),
        pendingUid: undefined,
      });
      this.clearFailed(kind, message.uid);
      if (this.shouldNotify(kind, message)) {
        await this.ntfy.notify(message.from, message.subject);
      }
      console.log(
        `[relay] ${kind} recovered pending uid ${pendingUid} (was already in Gmail)`,
      );
      return;
    }

    this.saveFolder(kind, { ...folder, pendingUid: undefined });
    console.log(
      `[relay] ${kind} pending uid ${pendingUid} not in Gmail; will re-process`,
    );
  }

  private async retryFailed(kind: FolderKind, uidValidity: number): Promise<void> {
    const folder = this.loadFolder(kind);
    const failed = folder.failed ?? {};
    const uids = Object.keys(failed)
      .map(Number)
      .filter((uid) => Number.isFinite(uid))
      .sort((a, b) => a - b);
    if (uids.length === 0) return;

    for (const uid of uids) {
      const message = await this.source.fetchOne(uid);
      if (!message) {
        this.clearFailed(kind, uid);
        console.log(`[relay] ${kind} failed uid ${uid} no longer on source; dropping`);
        continue;
      }

      try {
        const archived = this.isArchived(message);
        const treatAsSpam = !archived && (this.isSourceSpam(kind) || message.isSpam);
        if (treatAsSpam && this.spamAction === 'skip') {
          await this.source.deleteMessage(uid);
          this.clearFailed(kind, uid);
          this.advanceLastUid(kind, uidValidity, uid);
          console.log(`[relay] ${kind} skipped spam uid=${uid} on retry`);
          continue;
        }

        if (message.messageId && (await this.sink.hasMessageId(message.messageId))) {
          await this.source.deleteMessage(uid);
          this.clearFailed(kind, uid);
          this.advanceLastUid(kind, uidValidity, uid);
          if (this.shouldNotify(kind, message)) {
            await this.ntfy.notify(message.from, message.subject);
          }
          console.log(`[relay] ${kind} failed uid ${uid} already in Gmail; cleaned up`);
          continue;
        }

        const gmailFolder = this.gmailFolderFor(kind, message);
        await this.sink.append(message.raw, gmailFolder);
        await this.source.deleteMessage(uid);
        this.clearFailed(kind, uid);
        this.advanceLastUid(kind, uidValidity, uid);
        const spamNote = treatAsSpam ? ' (spam)' : archived ? ' (archive)' : '';
        console.log(
          `[relay] ${kind} delivered previously failed uid=${uid}${spamNote} folder=${gmailFolder} to="${message.to}" subject="${message.subject}"`,
        );
        if (this.shouldNotify(kind, message)) {
          await this.ntfy.notify(message.from, message.subject);
        }
      } catch (err) {
        await this.recordFailure(kind, message, uidValidity, err);
      }
    }
  }

  private gmailFolderFor(kind: FolderKind, message: SourceMessage): string {
    if (this.isArchived(message)) return '[Gmail]/All Mail';
    if (this.isSourceSpam(kind)) return '[Gmail]/Spam';
    if (!message.isSpam || this.spamAction === 'inbox') return 'INBOX';
    return '[Gmail]/Spam';
  }

  private async processOne(
    kind: FolderKind,
    message: SourceMessage,
    uidValidity: number,
  ): Promise<void> {
    const before = this.loadFolder(kind);
    const archived = this.isArchived(message);
    const treatAsSpam = !archived && (this.isSourceSpam(kind) || message.isSpam);

    if (treatAsSpam && this.spamAction === 'skip') {
      this.saveFolder(kind, {
        ...before,
        lastUid: before.lastUid,
        pendingUid: message.uid,
      });
      await this.source.deleteMessage(message.uid);
      this.saveFolder(kind, {
        ...before,
        lastUid: Math.max(before.lastUid, message.uid),
        pendingUid: undefined,
      });
      this.clearFailed(kind, message.uid);
      console.log(`[relay] ${kind} skipped spam uid=${message.uid} subject="${message.subject}"`);
      return;
    }

    this.saveFolder(kind, {
      ...before,
      lastUid: before.lastUid,
      pendingUid: message.uid,
    });

    const folder = this.gmailFolderFor(kind, message);
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
        await this.recordFailure(kind, message, uidValidity, err, { keepPending: true });
        return;
      }
      throw new Error(
        `Source delete failed for uid ${message.uid}: ${err instanceof Error ? err.message : err}`,
      );
    }

    this.saveFolder(kind, {
      ...before,
      lastUid: Math.max(before.lastUid, message.uid),
      pendingUid: undefined,
    });
    this.clearFailed(kind, message.uid);
    const spamNote = treatAsSpam ? ' (spam)' : archived ? ' (archive)' : '';
    console.log(
      `[relay] ${kind} delivered uid=${message.uid}${spamNote} folder=${folder} to="${message.to}" subject="${message.subject}"`,
    );
    if (this.shouldNotify(kind, message)) {
      await this.ntfy.notify(message.from, message.subject);
    }
  }

  private async recordFailure(
    kind: FolderKind,
    message: SourceMessage,
    uidValidity: number,
    error: unknown,
    opts: { keepPending?: boolean } = {},
  ): Promise<void> {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (isConnectionGone(error)) this.connectionLost = true;
    const folder = this.loadFolder(kind);
    const failed: Record<string, FailedEntry> = { ...(folder.failed ?? {}) };
    const key = String(message.uid);
    const prev = failed[key] ?? { attempts: 0, reported: false };
    const attempts = prev.attempts + 1;
    let reported = prev.reported;

    if (attempts >= MAX_FAIL_ATTEMPTS && !reported) {
      reported = await this.sendFailureNotice(kind, message, attempts, errMsg);
    }

    failed[key] = { attempts, reported };
    this.saveFolder(kind, {
      ...folder,
      uidValidity,
      lastUid: Math.max(folder.lastUid, message.uid),
      pendingUid: opts.keepPending ? message.uid : undefined,
      failed,
    });
    console.error(
      `[relay] ${kind} delivery failed uid=${message.uid} attempt=${attempts}/${MAX_FAIL_ATTEMPTS}: ${errMsg}`,
    );
  }

  private async sendFailureNotice(
    kind: FolderKind,
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
        `Message-ID: <imap2gmail-fail-${kind}-${message.uid}-${Date.now()}@imap2gmail>`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'imap2gmail could not deliver a message.',
        '',
        `Folder: ${this.mailboxPath(kind)}`,
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
      console.log(
        `[relay] ${kind} one-time failure notice for uid=${message.uid} appended to Gmail`,
      );
      return true;
    } catch (err) {
      console.error(
        `[relay] ${kind} failure notice failed for uid=${message.uid}:`,
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  private clearFailed(kind: FolderKind, uid: number): void {
    const folder = this.loadFolder(kind);
    const failed = { ...(folder.failed ?? {}) };
    const key = String(uid);
    if (!(key in failed)) return;
    delete failed[key];
    this.saveFolder(kind, { ...folder, failed });
  }

  private advanceLastUid(kind: FolderKind, uidValidity: number, uid: number): void {
    const folder = this.loadFolder(kind);
    this.saveFolder(kind, {
      ...folder,
      uidValidity,
      lastUid: Math.max(folder.lastUid, uid),
      pendingUid: undefined,
    });
  }
}
