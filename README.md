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
   - 🛡️ If spam header + `SPAM__ACTION=gmail-spam` → append to Gmail Spam, skip ntfy
   - ✉️ Gmail `append(INBOX or [Gmail]/Spam, raw)`
   - 🗑️ Source UID `\Deleted` + expunge
   - ❌ Append failed → count in `state.failed`, advance past UID, retry later (no queue jam)
   - ⚠️ Delete failed after successful append → Gmail rollback (search by Message-ID and expunge)
   - 📮 3rd failure → one-time Gmail notice, still retried, no error ntfy
   - 💾 Save state → 🔔 ntfy POST *("From – Subject")* on success only
4. 😴 IDLE: imapflow auto-IDLE; `exists` event → catch-up
5. ⏱️ Fallback poll every `FALLBACK_POLL_SECONDS` (safety net)
6. 🔌 Reconnect: imapflow recovery + own catch-up
7. 🚨 Crash window Append↔Delete: `pendingUid` in state → targeted recovery on startup

### 🛡️ Spam handling

Source headers `X-Spam-Flag`, `X-Spam-Status`, `X-UI-Filterresults` are checked:

| `SPAM__ACTION` | Behavior |
|---|---|
| `gmail-spam` *(default)* | Append to Gmail `[Gmail]/Spam`, no ntfy, still delete source |
| `inbox` | Append to Gmail `INBOX` as usual (log only) |
| `skip` | Do not append to Gmail; delete from source |

💡 Tip: prefer provider-side spam folders *(e.g. 1und1/IONOS → move to Spam)* so spam never reaches this relay.

### 🚨 Failure handling

- 🧩 A single bad mail **does not block** later mails (per-message try/catch)
- 🔁 Failed UIDs stay on the source, are retried every catch-up, counted in `state.failed`
- 📮 After **3 failed attempts** → **one** notice mail to Gmail INBOX  
  `[imap2gmail] not delivered: <subject>` (never repeated for that UID)
- 📭 No error ntfy pushes; details stay in `docker compose logs`
- 💥 Crash between append↔delete → `pendingUid` recovery (Message-ID check)

### 🗃️ State (`/data/state.json`)

```json
{
  "uidValidity": 123456,
  "lastUid": 98765,
  "pendingUid": null,
  "failed": { "42": { "attempts": 1, "reported": false } }
}
```

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
| `GMAIL__EMAIL` / `GMAIL__APP_PASSWORD` | 📤 Gmail target *(app password)* |
| `GMAIL__HOST/PORT` | 🌐 Default `imap.gmail.com:993` |
| `NTFY__TOPIC_URL` | 🔔 e.g. `https://ntfy.sh/my-topic`; empty = off |
| `NTFY__BLACKLIST` | 🤫 From addresses without ntfy *(comma-separated)*, e.g. `user@example.org` |
| `SPAM__ACTION` | 🛡️ `gmail-spam` *(default)* \| `inbox` \| `skip` – handling for source spam headers |
| `FALLBACK_POLL_SECONDS` | ⏱️ Default `60` |
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
│   ├── sink.ts      # 📤 imapflow Gmail: append (INBOX/Spam), rollback
│   ├── relay.ts     # 🔄 Catch-up, pending-UID, spam, failure retries/notice, ntfy
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
