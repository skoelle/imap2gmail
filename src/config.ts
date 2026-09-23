export interface ImapAccountConfig {
  host: string;
  port: number;
  email: string;
  password: string;
}

export interface AppConfig {
  source: ImapAccountConfig;
  gmail: ImapAccountConfig;
  ntfyTopicUrl: string;
  ntfyBlacklist: string[];
  fallbackPollSeconds: number;
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
    gmail: {
      host: optionalEnv('GMAIL__HOST', 'imap.gmail.com'),
      port: intEnv('GMAIL__PORT', 993),
      email: requireEnv('GMAIL__EMAIL'),
      password: requireEnv('GMAIL__APP_PASSWORD'),
    },
    ntfyTopicUrl: optionalEnv('NTFY__TOPIC_URL', ''),
    ntfyBlacklist: listEnv('NTFY__BLACKLIST'),
    fallbackPollSeconds: intEnv('FALLBACK_POLL_SECONDS', 60),
    stateFile: optionalEnv('STATE_FILE', '/data/state.json'),
  };
}
