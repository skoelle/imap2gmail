// Copyright (c) 2026 Stefan Koelle (https://stefankoelle.de)
// Licensed under the MIT License. See LICENSE file in project root for details.
import { readFile, stat } from 'node:fs/promises';
import type { SourceMessage } from './source.js';

/** One rule: every set field must match (case-insensitive "contains"). */
interface RemoveRule {
  subject?: string;
  from?: string;
  /** Bare line: matches when subject OR from contains the text. */
  any?: string;
}

/**
 * Remove-list file: matching messages are moved to the source trash and never
 * delivered to Gmail. The file is re-read whenever its mtime/size changes,
 * so edits apply on the next catch-up without a restart.
 */
export class Blocklist {
  private rules: RemoveRule[] = [];
  private loadedKey: string | null = null;
  private missingLogged = false;

  /** An empty path disables the blocklist. */
  constructor(private readonly filePath: string) {}

  get enabled(): boolean {
    return this.filePath !== '';
  }

  get count(): number {
    return this.rules.length;
  }

  /** Re-read the file when it changed; never throws, keeps previous rules on read errors. */
  async reload(): Promise<void> {
    if (!this.enabled) return;
    const info = await stat(this.filePath).catch(() => null);
    if (!info) {
      if (this.loadedKey !== null) {
        this.loadedKey = null;
        this.rules = [];
        console.log(`[blocklist] ${this.filePath} removed; rules cleared`);
        return;
      }
      if (!this.missingLogged) {
        this.missingLogged = true;
        console.log(`[blocklist] ${this.filePath} not found; remove rules disabled`);
      }
      return;
    }
    const key = `${info.mtimeMs}:${info.size}`;
    if (key === this.loadedKey) return;
    try {
      const rules = parseRemoveRules(await readFile(this.filePath, 'utf8'));
      this.loadedKey = key;
      this.missingLogged = false;
      this.rules = rules;
      console.log(`[blocklist] ${rules.length} rules loaded from ${this.filePath}`);
    } catch (err) {
      console.warn(
        `[blocklist] reload failed, keeping previous rules:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  matches(message: SourceMessage): boolean {
    if (this.rules.length === 0) return false;
    const subject = message.subject.toLowerCase();
    const from = message.from.toLowerCase();
    return this.rules.some((rule) => {
      if (rule.subject !== undefined && !subject.includes(rule.subject)) return false;
      if (rule.from !== undefined && !from.includes(rule.from)) return false;
      if (rule.any !== undefined && !subject.includes(rule.any) && !from.includes(rule.any)) {
        return false;
      }
      return true;
    });
  }
}

/**
 * One rule per line: `#` comments and blank lines are ignored.
 * A line is parsed as DSL when any `|`-separated piece starts with
 * `from~` / `subject~` (`|` = AND); any other line matches subject OR from
 * as a plain substring. Invalid lines are silently skipped.
 */
function parseRemoveRules(raw: string): RemoveRule[] {
  const rules: RemoveRule[] = [];
  const lines = raw.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const pieces = line.split('|');
    const isDsl = pieces.some((piece) => /^(subject|from)~/i.test(piece.trim()));
    if (!isDsl) {
      rules.push({ any: line.toLowerCase() });
      continue;
    }
    const rule: RemoveRule = {};
    let valid = true;
    for (const cond of pieces) {
      const piece = cond.trim();
      if (!piece) continue;
      const match = /^(subject|from)~(.*)$/i.exec(piece);
      if (!match || !match[2].trim()) {
        valid = false;
        break;
      }
      rule[match[1].toLowerCase() as 'subject' | 'from'] = match[2].trim().toLowerCase();
    }
    if (!valid || (rule.subject === undefined && rule.from === undefined)) continue;
    rules.push(rule);
  }
  return rules;
}
