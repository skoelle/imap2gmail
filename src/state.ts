// Copyright (c) 2026 Stefan Koelle (https://stefankoelle.de)
// Licensed under the MIT License. See LICENSE file in project root for details.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface FailedEntry {
  attempts: number;
  reported: boolean;
}

export interface RelayState {
  uidValidity: number;
  lastUid: number;
  /** UID where Append succeeded but source-delete is not confirmed yet. */
  pendingUid?: number;
  /** Delivery failures still retried on the source (key = UID). */
  failed?: Record<string, FailedEntry>;
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

export class StateStore {
  constructor(private readonly filePath: string) {}

  load(): RelayState {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<RelayState>;
      return {
        uidValidity: Number(parsed.uidValidity ?? 0),
        lastUid: Number(parsed.lastUid ?? 0),
        pendingUid:
          parsed.pendingUid === undefined || parsed.pendingUid === null
            ? undefined
            : Number(parsed.pendingUid),
        failed: parseFailed(parsed.failed),
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { ...EMPTY_STATE };
      throw err;
    }
  }

  save(state: RelayState): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.filePath);
  }
}
