// Copyright (c) 2026 Stefan Koelle (https://stefankoelle.de)
// Licensed under the MIT License. See LICENSE file in project root for details.
export class Ntfy {
  private readonly blacklist: Set<string>;

  constructor(
    private readonly topicUrl: string,
    blacklist: string[] = [],
  ) {
    this.blacklist = new Set(blacklist.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
  }

  get enabled(): boolean {
    return this.topicUrl.trim() !== '';
  }

  isBlacklisted(from: string): boolean {
    if (this.blacklist.size === 0) return false;
    const normalized = from.trim().toLowerCase();
    if (!normalized) return false;
    if (this.blacklist.has(normalized)) return true;
    for (const entry of this.blacklist) {
      if (normalized.includes(entry)) return true;
    }
    return false;
  }

  async notify(from: string, subject: string): Promise<void> {
    if (!this.enabled) return;
    if (this.isBlacklisted(from)) {
      console.log(`[ntfy] skipped (blacklist): ${from}`);
      return;
    }
    const line = `${from || '(unknown)'} – ${subject || '(no subject)'}`;
    await this.post(line, 'email,inbox');
  }

  async system(body: string, kind: 'problem' | 'recovered'): Promise<void> {
    if (!this.enabled) return;
    const tags = kind === 'problem' ? 'warning,unplug' : 'white_check_mark';
    await this.post(body, tags);
  }

  private async post(body: string, tags: string): Promise<void> {
    try {
      const res = await fetch(this.topicUrl, {
        method: 'POST',
        body,
        headers: {
          Title: 'imap2gmail',
          Tags: tags,
          Priority: 'urgent',
        },
      });
      if (!res.ok) {
        console.warn(`[ntfy] HTTP ${res.status} for POST ${this.topicUrl}`);
      }
    } catch (err) {
      console.warn(`[ntfy] POST failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
