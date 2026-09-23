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
    const line = `${from || '(unbekannt)'} – ${subject || '(ohne Betreff)'}`;
    try {
      const res = await fetch(this.topicUrl, {
        method: 'POST',
        body: line,
        headers: {
          Title: 'imap2gmail',
          Tags: 'email,inbox',
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
