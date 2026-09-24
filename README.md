# 📬 imap2gmail

> 🔄 Replaces Gmail POP fetching *(“Get mail from other accounts”, being shut down in 2026/2027)*
> with a tiny long-running container.

**📥 Fetch from source IMAP → 📤 APPEND to Gmail → 🗑️ really delete source mail → 🔔 optional ntfy.**

🧰 Stack: TypeScript + [imapflow](https://github.com/postalsys/imapflow)
(IDLE long-run, raw stream, `append`, flags + expunge).

---

## 🏗️ Architecture

```
📭 Source IMAP (test account / forward target)       📮 Gmail IMAP
┌──────────────────────────────┐               ┌──────────────────┐
│ imapflow: select INBOX       │               │ append           │
│ Catch-up: uid > lastUid      │──raw RFC822──▶│ (raw Buffer)     │
│ IDLE + fallback poll         │               └──────────────────┘
│   every N seconds            │                      │ ✅ on success
│ State: uidValidity + lastUid │               Source: \Deleted +
└──────────────────────┬───────┘               EXPUNGE (really gone)
                       │                              │
                       ▼                              ▼
                 🗃️ state.json (/data)          🔔 ntfy HTTP-POST (optional)
```

### 🔄 Flow

1. 📡 Connect to source, select INBOX, compare `uidValidity` against state
2. 🧹 Catch-up: fetch all `uid > lastUid` as raw RFC822 buffers
3. 📨 Per message:
   - 📦 If `ARCHIVE__RULES` match → append to Gmail `[Gmail]/All Mail`, **no ntfy** *(before spam)*
   - 🛡️ If spam header + `SPAM__ACTION=gmail-spam` → append to Gmail Spam, skip ntfy
   - ✉️ Gmail `append(INBOX or [Gmail]/All Mail or [Gmail]/Spam, raw)`
   - 🗑️ Source UID `\Deleted` + expunge
   - ❌ Append failed → count in `state.failed`, advance past UID, retry later (no queue jam)
   - ⚠️ Delete failed after successful append → Gmail rollback (search by Message-ID and expunge)
   - 📮 3rd failure → one-time Gmail notice, still retried, no error ntfy
   - 💾 Save state → 🔔 ntfy POST *("From – Subject")* on success only
   - 📋 Log line includes first recipient `to="…"` *(grep-able; ntfy unchanged)*

4. 😴 IDLE: imapflow auto-IDLE; `exists` event → catch-up
5. ⏱️ Fallback poll every `FALLBACK_POLL_SECONDS` (safety net)
6. 🔌 Reconnect: **new ImapFlow instance** (single-use) + backoff (3s → 60s) + catch-up  
   - 🔄 Source/Gmail ops rebuild the client once on `Connection not available`  
   - ⚠️ After `RECONNECT__ALERT_SECONDS` (default 1h) failed catch-up/reconnect → **one** ntfy per container start  
   - ✅ Full catch-up after that alert → **one** recovery ntfy
7. 🚨 Crash window Append↔Delete: `pendingUid` in state → targeted recovery on startup

**Recipient frequency** (docker logs only):

```bash
docker compose logs | grep -o 'to="[^"]*"' | sort | uniq -c | sort -rn
```

### 📦 Archive rules (`ARCHIVE__RULES`)

Route matching mail to Gmail **All Mail** instead of INBOX *(archived – no Inbox badge)*.
Checked **before** spam; **no ntfy**; source still deleted.

```bash
# ; = rules (OR, first match wins), | = conditions in one rule (AND)
# subject~ / from~ = case-insensitive "contains"
ARCHIVE__RULES=subject~Newsletter;subject~Receipt|from~noreply@shop.de
```

| Piece | Meaning |
|---|---|
| `subject~text` | Subject contains `text` |
| `from~text` | From header contains `text` |
| `\|` | Both must match |
| `;` | Next rule; empty = feature off |

Spam (`SPAM__ACTION`) still applies only if **no** archive rule matched.

### 🛡️ Spam handling

Two independent paths:

**A) INBOX headers** (`X-Spam-Flag`, `X-Spam-Status`, `X-UI-Filterresults`):

| `SPAM__ACTION` | Behavior |
|---|---|
| `gmail-spam` *(default)* | Append to Gmail `[Gmail]/Spam`, no ntfy, still delete source |
| `inbox` | Append to Gmail `INBOX` as usual (log only) |
| `skip` | Do not append to Gmail; delete from source |

**B) Source spam folder** (`SOURCE__SPAM_FOLDER=Spam`, optional):

- Polled on every catch-up *(no IDLE on that folder; max ~`FALLBACK_POLL_SECONDS` delay)*
- Always → Gmail `[Gmail]/Spam` (or delete-only if `SPAM__ACTION=skip`)
- **Never ntfy**
- Own cursor in `state.spam` (UIDs are per mailbox)

💡 Tip: keep provider spam *in its source folder* **or** in INBOX with headers – both land in Gmail Spam for review.

### 🚨 Failure handling

- 🧩 A single bad mail **does not block** later mails (per-message try/catch)
- 🔁 Failed UIDs stay on the source, are retried every catch-up, counted in `state.failed`
- 📮 After **3 failed attempts** → **one** notice mail to Gmail INBOX  
  `[imap2gmail] not delivered: <subject>` (never repeated for that UID)
- 📭 No error ntfy pushes for per-mail failures; details stay in `docker compose logs`  
- ⚠️ **Connection** alerts: one system ntfy after `RECONNECT__ALERT_SECONDS` of failed catch-up/reconnect (source *or* Gmail), then one recovery ntfy (not From-Blacklisted)
- 💥 Crash between append↔delete → `pendingUid` recovery (Message-ID check)

### 🗃️ State (`/data/state.json`)

```json
{
  "uidValidity": 123456,
  "lastUid": 98765,
  "pendingUid": null,
  "failed": { "42": { "attempts": 1, "reported": false } },
  "spam": { "uidValidity": 111, "lastUid": 5, "failed": {} }
}
```

- Top level = **INBOX**; `spam` = optional source spam folder
- 🔄 After restart → only `uid > lastUid` → **no duplicates**
- 🔁 `uidValidity` change → reset + rework any open UID

---

## ⚙️ Setup

### 1️⃣ Create a source IMAP test account

📝 Create a new IMAP test account *(any provider you like)*. Later, forward
your domain mail to this address – **without migrating** existing mail
(source IMBOX empty, Gmail already has everything).

### 2️⃣ Gmail app password

🔐 Google Account → Security → 2-Step Verification → create an **App password**
(<https://myaccount.google.com/apppasswords>).

### 3️⃣ Create `.env`

```bash
cp .env.example .env
# ✏️ fill in values
```

| Variable | Meaning |
|---|---|
| `SOURCE__HOST/PORT/EMAIL/PASSWORD` | 📥 Source IMAP |
| `SOURCE__SPAM_FOLDER` | 🛡️ Optional source spam folder *(e.g. `Spam`)* → Gmail Spam, no ntfy; empty = off |
| `GMAIL__EMAIL` / `GMAIL__APP_PASSWORD` | 📤 Gmail target *(app password)* |
| `GMAIL__HOST/PORT` | 🌐 Default `imap.gmail.com:993` |
| `NTFY__TOPIC_URL` | 🔔 e.g. `https://ntfy.sh/my-topic`; empty = off |
| `NTFY__BLACKLIST` | 🤫 From addresses without ntfy *(comma-separated)*, e.g. `user@example.org` |
| `SPAM__ACTION` | 🛡️ `gmail-spam` *(default)* \| `inbox` \| `skip` – handling for source spam headers |
| `ARCHIVE__RULES` | 📦 Optional rules → Gmail All Mail, no ntfy; empty = off *(see above)* |
| `FALLBACK_POLL_SECONDS` | ⏱️ Default `60` |
| `RECONNECT__ALERT_SECONDS` | ⚠️ ntfy after sustained reconnect failure; default `3600` (1h), once per container + recovery |
| `IDLE__TIMEOUT_SECONDS` | ⏱️ Hard cap per IDLE wait (default `600`); on expiry the source client is rebuilt |
| `HEALTH__PORT` / `HEALTH__STALE_SECONDS` | 🩺 Optional health endpoint `:PORT/healthz` (unset = off); `200` while last full catch-up is younger than stale (default `900`s), else `503` |
| `STATE_FILE` | 🗃️ Default `/data/state.json` |

### 4️⃣ 🚀 Start

```bash
# pull published image (or build locally with --build)
docker compose pull
docker compose up -d
docker compose logs -f
```

📦 Image: `ghcr.io/skoelle/imap2gmail:latest`

**Local build** *(instead of pull)*:

```bash
docker compose up --build -d
```

**Local** *(without Docker)*:

```bash
npm install
npm run build
# load .env into the environment, then:
npm start
```

---

## 🧪 Test procedure

1. 📝 Create a new IMAP test account, fill in `.env`
2. 🐳 `docker compose pull && docker compose up -d`
3. ✉️ Send a test mail to the test account → verify:
   - ✅ Mail visible in Gmail
   - 🧹 Test account INBOX **empty** *(deleted)*
   - 📈 `data/state.json` advanced
   - 🔔 ntfy arrives *(if configured)*
4. 🔄 Restart the container → **no duplicate delivery**
5. 📡 Brief network drop → reconnect + catch-up without loss/duplicates
6. 🎉 If it works → enable forwarding to the test address

---

## 🔌 Switching off Gmail POP *(manual, after a successful test)*

> ⚠️ **Important:** Only switch once imap2gmail is stable – otherwise you risk
> double fetching until POP is removed *(Jan 2027)*.

1. ✅ Complete the test phase as above
2. 📤 Enable forwarding to the test address
3. 🗑️ Remove the old POP account in Gmail:
   **Settings → Accounts and Import → “Get mail from other accounts”**
   → remove account
4. 💚 Already imported mails stay in Gmail
   *(source: <https://support.google.com/mail/answer/16604719>)*

ℹ️ **Background:** Google is turning POP off – no new setups since Q1 2026,
existing use until Jan 2027, then full removal.

---

## 🛠️ Development

```bash
npm run build   # 🔨 tsc
npm run dev     # ⚡ tsx src/index.ts
```

### 📁 Project structure

```
imap2gmail/
├── 📦 src/
│   ├── index.ts     # 🚪 Entry, main loop, shutdown
│   ├── config.ts    # ⚙️ Env vars
│   ├── state.ts     # 🗃️ JSON state: uid, pendingUid, failed attempts
│   ├── source.ts    # 📥 imapflow source: connect, IDLE, fetch raw, delete, spam header
│   ├── sink.ts      # 📤 imapflow Gmail: append (INBOX/All Mail/Spam), rollback
│   ├── relay.ts     # 🔄 Catch-up, archive rules, spam, failure retries/notice, ntfy
│   └── ntfy.ts      # 🔔 HTTP-POST *(empty URL = off)*
├── 🐳 Dockerfile
├── 🐳 docker-compose.yml
└── 📄 .env.example
```

---

## 📜 License

Licensed under the [MIT License](LICENSE) – Copyright (c) 2026 [Stefan Koelle](https://stefankoelle.de)

---

⭐ **Enjoy silent, POP-free mail syncing!** ⭐
