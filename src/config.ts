// Copyright (c) 2026 Stefan Koelle (https://stefankoelle.de)
// Licensed under the MIT License. See LICENSE file in project root for details.
export interface ImapAccountConfig {
  host: string;
  port: number;
  email: string;
  password: string;
}

export type SpamAction = 'gmail-spam' | 'inbox' | 'skip';

/** Fallback locale for the Gmail All Mail folder name (primary: SPECIAL-USE \All discovery). */
export type GmailLocale = 'de' | 'en';

/** Route to Gmail All Mail when all set fields match (case-insensitive contains). */
export interface ArchiveRule {
  subject?: string;
  from?: string;
}

export interface AppConfig {
  source: ImapAccountConfig;
  /** Source spam folder path (e.g. "Spam"); empty = disabled. */
  sourceSpamFolder: string;
  gmail: ImapAccountConfig;
  gmailLocale: GmailLocale;
  ntfyTopicUrl: string;
  ntfyBlacklist: string[];
  spamAction: SpamAction;
  archiveRules: ArchiveRule[];
  fallbackPollSeconds: number;
  reconnectAlertSeconds: number;
  idleTimeoutSeconds: number;
  healthPort: number;
  healthStaleSeconds: number;
  stateFile: string;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? fallback : value;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid integer for ${name}: ${raw}`);
  }
  return value;
}

function listEnv(name: string): string[] {
  const raw = optionalEnv(name, '');
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function loadConfig(): AppConfig {
  return {
    source: {
      host: requireEnv('SOURCE__HOST'),
      port: intEnv('SOURCE__PORT', 993),
      email: requireEnv('SOURCE__EMAIL'),
      password: requireEnv('SOURCE__PASSWORD'),
    },
    sourceSpamFolder: optionalEnv('SOURCE__SPAM_FOLDER', ''),
    gmail: {
      host: optionalEnv('GMAIL__HOST', 'imap.gmail.com'),
      port: intEnv('GMAIL__PORT', 993),
      email: requireEnv('GMAIL__EMAIL'),
      password: requireEnv('GMAIL__APP_PASSWORD'),
    },
    gmailLocale: gmailLocaleEnv(),
    ntfyTopicUrl: optionalEnv('NTFY__TOPIC_URL', ''),
    ntfyBlacklist: listEnv('NTFY__BLACKLIST'),
    spamAction: spamActionEnv(),
    archiveRules: parseArchiveRules(optionalEnv('ARCHIVE__RULES', '')),
    fallbackPollSeconds: intEnv('FALLBACK_POLL_SECONDS', 60),
    reconnectAlertSeconds: intEnv('RECONNECT__ALERT_SECONDS', 3600),
    idleTimeoutSeconds: intEnv('IDLE__TIMEOUT_SECONDS', 600),
    healthPort: intEnv('HEALTH__PORT', 0),
    healthStaleSeconds: intEnv('HEALTH__STALE_SECONDS', 900),
    stateFile: optionalEnv('STATE_FILE', '/data/state.json'),
  };
}

function spamActionEnv(): SpamAction {
  const raw = optionalEnv('SPAM__ACTION', 'gmail-spam').toLowerCase();
  if (raw === 'gmail-spam' || raw === 'inbox' || raw === 'skip') return raw;
  throw new Error(`Invalid SPAM__ACTION: ${raw} (expected gmail-spam|inbox|skip)`);
}

function gmailLocaleEnv(): GmailLocale {
  const raw = optionalEnv('GMAIL__LOCALE', 'de').toLowerCase();
  if (raw === 'de' || raw === 'en') return raw;
  throw new Error(`Invalid GMAIL__LOCALE: ${raw} (expected de|en)`);
}

/** Fallback name for Gmail's All Mail folder (primary resolution: SPECIAL-USE \All via LIST). */
export function archiveFolderFor(locale: GmailLocale): string {
  return locale === 'en' ? '[Gmail]/All Mail' : '[Gmail]/Alle E-Mails';
}

/** `;` = rules (OR), `|` = conditions in one rule (AND): `subject~Foo|from~bar@` */
function parseArchiveRules(raw: string): ArchiveRule[] {
  if (!raw) return [];
  const rules: ArchiveRule[] = [];
  for (const rulePart of raw.split(';')) {
    const trimmed = rulePart.trim();
    if (!trimmed) continue;
    const rule: ArchiveRule = {};
    for (const cond of trimmed.split('|')) {
      const piece = cond.trim();
      if (!piece) continue;
      const match = /^(subject|from)~(.+)$/i.exec(piece);
      if (!match) {
        throw new Error(`Invalid ARCHIVE__RULES condition: ${piece}`);
      }
      const key = match[1].toLowerCase() as 'subject' | 'from';
      const value = match[2].trim();
      if (!value) {
        throw new Error(`Empty ARCHIVE__RULES value: ${piece}`);
      }
      rule[key] = value;
    }
    if (rule.subject === undefined && rule.from === undefined) {
      throw new Error(`Empty ARCHIVE__RULES rule: ${trimmed}`);
    }
    rules.push(rule);
  }
  return rules;
}
