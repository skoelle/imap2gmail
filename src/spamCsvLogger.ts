// Copyright (c) 2026 Stefan Koelle (https://stefankoelle.de)
// Licensed under the MIT License. See LICENSE file in project root for details.
import { appendFile, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SourceMessage } from './source.js';

const HEADER = 'timestamp,uid,from,to,subject,sourceFolder\n';

/** Appends one CSV row per processed SPAM message; write errors never break delivery. */
export class SpamCsvLogger {
  private headerChecked = false;

  /** An empty path disables logging. */
  constructor(private readonly filePath: string) {}

  get enabled(): boolean {
    return this.filePath !== '';
  }

  async log(message: SourceMessage, sourceFolder: string): Promise<void> {
    if (!this.enabled) return;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      if (!this.headerChecked) {
        const info = await stat(this.filePath).catch(() => null);
        if (!info || info.size === 0) {
          await appendFile(this.filePath, HEADER, 'utf8');
        }
        this.headerChecked = true;
      }
      const row = [
        new Date().toISOString(),
        String(message.uid),
        csvField(message.from),
        csvField(message.to),
        csvField(message.subject),
        csvField(sourceFolder),
      ].join(',');
      await appendFile(this.filePath, `${row}\n`, 'utf8');
    } catch (err) {
      console.warn('[spam-csv] write failed:', err instanceof Error ? err.message : err);
    }
  }
}

/** Quote a CSV field when it contains separators, quotes or line breaks. */
function csvField(value: string): string {
  const text = value ?? '';
  return /["\n\r,]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
