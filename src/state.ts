// Copyright (c) 2026 Stefan Koelle (https://stefankoelle.de)
// Licensed under the MIT License. See LICENSE file in project root for details.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface FailedEntry {
  attempts: number;
  reported: boolean;
}

/** Per-mailbox delivery cursor (UIDs are scoped to one mailbox). */
export interface FolderState {
  uidValidity: number;
  lastUid: number;
  /** UID where Append succeeded but source-delete is not confirmed yet. */
  pendingUid?: number;
  /** Delivery failures still retried on the source (key = UID). */
  failed?: Record<string, FailedEntry>;
}

/** Top-level fields = INBOX; optional `spam` = source spam folder. */
export interface RelayState extends FolderState {
  spam?: FolderState;
}

const EMPTY_STATE: RelayState = { uidValidity: 0, lastUid: 0 };

function parseFailed(raw: unknown): Record<string, FailedEntry> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, FailedEntry> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Partial<FailedEntry>;
    out[key] = {
      attempts: Number(entry.attempts ?? 0),
      reported: Boolean(entry.reported),
    };
  }
  return out;
}

function parseFolder(raw: unknown): FolderState | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const parsed = raw as Partial<FolderState>;
  const pending =
    parsed.pendingUid === undefined || parsed.pendingUid === null
      ? undefined
      : Number(parsed.pendingUid);
  return {
    uidValidity: Number(parsed.uidValidity ?? 0),
    lastUid: Number(parsed.lastUid ?? 0),
    pendingUid: pending,
    failed: parseFailed(parsed.failed),
  };
}

export class StateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<RelayState> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<RelayState>;
      const spam = parseFolder(parsed.spam);
      return {
        uidValidity: Number(parsed.uidValidity ?? 0),
        lastUid: Number(parsed.lastUid ?? 0),
        pendingUid:
          parsed.pendingUid === undefined || parsed.pendingUid === null
            ? undefined
            : Number(parsed.pendingUid),
        failed: parseFailed(parsed.failed),
        ...(spam ? { spam } : {}),
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { ...EMPTY_STATE };
      throw err;
    }
  }

  /** Atomic tmp+rename write; never partially overwrites the state file. */
  async save(state: RelayState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tmp, this.filePath);
  }
}
