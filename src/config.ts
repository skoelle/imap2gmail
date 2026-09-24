// Copyright (c) 2026 Stefan Koelle (https://stefankoelle.de)
// Licensed under the MIT License. See LICENSE file in project root for details.
export interface ImapAccountConfig {
  host: string;
  port: number;
  email: string;
  password: string;
}

export type SpamAction = 'gmail-spam' | 'inbox' | 'skip';

export interface AppConfig {
  source: ImapAccountConfig;
  /** Source spam folder path (e.g. "Spam"); empty = disabled. */
  sourceSpamFolder: string;
  gmail: ImapAccountConfig;
  ntfyTopicUrl: string;
  ntfyBlacklist: string[];
  spamAction: SpamAction;
  fallbackPollSeconds: number;
  reconnectAlertSeconds: number;
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
    ntfyTopicUrl: optionalEnv('NTFY__TOPIC_URL', ''),
    ntfyBlacklist: listEnv('NTFY__BLACKLIST'),
    spamAction: spamActionEnv(),
    fallbackPollSeconds: intEnv('FALLBACK_POLL_SECONDS', 60),
    reconnectAlertSeconds: intEnv('RECONNECT__ALERT_SECONDS', 3600),
    stateFile: optionalEnv('STATE_FILE', '/data/state.json'),
  };
}

function spamActionEnv(): SpamAction {
  const raw = optionalEnv('SPAM__ACTION', 'gmail-spam').toLowerCase();
  if (raw === 'gmail-spam' || raw === 'inbox' || raw === 'skip') return raw;
  throw new Error(`Invalid SPAM__ACTION: ${raw} (expected gmail-spam|inbox|skip)`);
}
