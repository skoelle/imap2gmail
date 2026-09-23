# imap2gmail

Replaces Gmail POP fetching (“Get mail from other accounts”, disabled in 2026/2027)
with a long-running container:

**Fetch from source IMAP → APPEND to Gmail → really delete source mail → optional ntfy.**

Stack: TypeScript + [imapflow](https://github.com/postalsys/imapflow)
(IDLE long-run, raw stream, `append`, flags + expunge).

## Architecture

```
Source IMAP (test account / forward target)       Gmail IMAP
┌──────────────────────────────┐               ┌──────────────────┐
│ imapflow: select INBOX       │               │ append           │
│ Catch-up: uid > lastUid      │──raw RFC822──▶│ (raw Buffer)     │
│ IDLE + fallback poll         │               └──────────────────┘
│   every N seconds            │                      │ on success
│ State: uidValidity + lastUid │               Source: \Deleted +
└──────────────────────┬───────┘               EXPUNGE (really gone)
                       │                              │
                       ▼                              ▼
                 state.json (/data)            ntfy HTTP-POST (optional)
```

### Flow

1. Connect to source, select INBOX, compare `uidValidity` against state
2. Catch-up: fetch all `uid > lastUid` as raw RFC822 buffers
3. Per message:
   - Gmail `append(INBOX, raw)`
   - Source UID `\Deleted` + expunge
   - Append failed: do not advance state, retry
   - Delete failed after successful append: Gmail rollback (search by Message-ID and expunge)
   - Save state → ntfy POST (“From – Subject”)
4. IDLE: imapflow auto-IDLE; `exists` event → catch-up
5. Fallback poll every `FALLBACK_POLL_SECONDS` (safety net)
6. Reconnect: imapflow recovery + own catch-up
7. Crash window Append↔Delete: `pendingUid` in state → targeted recovery on startup

### State (`/data/state.json`)

```json
{ "uidValidity": 123456, "lastUid": 98765, "pendingUid": null }
```

- After restart: only `uid > lastUid` → no duplicates
- `uidValidity` change: reset + rework any open UID

## Setup

### 1. Create a source IMAP test account

Create a new IMAP test account (any provider you like). Later, forward
your domain mail to this address – **without migrating** existing mail
(source IMAP empty, Gmail already has everything).

### 2. Gmail app password

Google Account → Security → 2-Step Verification → create an **App password**
(<https://myaccount.google.com/apppasswords>).

### 3. Create `.env`

```bash
cp .env.example .env
# fill in values
```

| Variable | Meaning |
|---|---|
| `SOURCE__HOST/PORT/EMAIL/PASSWORD` | Source IMAP |
| `GMAIL__EMAIL` / `GMAIL__APP_PASSWORD` | Gmail target (app password) |
| `GMAIL__HOST/PORT` | Default `imap.gmail.com:993` |
| `NTFY__TOPIC_URL` | e.g. `https://ntfy.sh/my-topic`; empty = off |
| `NTFY__BLACKLIST` | From addresses without ntfy (comma-separated), e.g. `user@example.org` |
| `FALLBACK_POLL_SECONDS` | Default `60` |
| `STATE_FILE` | Default `/data/state.json` |

### 4. Start

```bash
docker compose up --build -d
docker compose logs -f
```

Local (without Docker):

```bash
npm install
npm run build
# load .env into the environment, then:
npm start
```

## Test procedure

1. Create a new IMAP test account, fill in `.env`
2. `docker compose up --build`
3. Send a test mail to the test account → verify:
   - Mail visible in Gmail
   - Test account INBOX **empty** (deleted)
   - `data/state.json` advanced
   - ntfy arrives (if configured)
4. Restart the container → no duplicate delivery
5. Brief network drop → reconnect + catch-up without loss/duplicates
6. If it works: enable forwarding to the test address

## Switching off Gmail POP (manual, after a successful test)

> **Important:** Only switch once imap2gmail is stable – otherwise you risk
> double fetching until POP is removed (Jan 2027).

1. Complete the test phase as above
2. Enable forwarding to the test address
3. Remove the old POP account in Gmail:
   **Settings → Accounts and Import → “Get mail from other accounts”**
   → remove account
4. Already imported mails stay in Gmail
   (source: <https://support.google.com/mail/answer/16604719>)

Background: Google is turning POP off – no new setups since Q1 2026,
existing use until Jan 2027, then full removal.

## Development

```bash
npm run build   # tsc
npm run dev     # tsx src/index.ts
```

### Project structure

```
imap2gmail/
├── src/
│   ├── index.ts     # Entry, main loop, shutdown
│   ├── config.ts    # Env vars
│   ├── state.ts     # JSON state read/write
│   ├── source.ts    # imapflow source: connect, IDLE, fetch raw, delete
│   ├── sink.ts      # imapflow Gmail: append, rollback
│   ├── relay.ts     # Catch-up, pending-UID, errors/rollback, ntfy
│   └── ntfy.ts      # HTTP-POST (empty URL = off)
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

## License

MIT
