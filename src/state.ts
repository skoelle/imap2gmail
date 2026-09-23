import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface RelayState {
  uidValidity: number;
  lastUid: number;
  /** UID where Append succeeded but source-delete is not confirmed yet. */
  pendingUid?: number;
}

const EMPTY_STATE: RelayState = { uidValidity: 0, lastUid: 0 };

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
