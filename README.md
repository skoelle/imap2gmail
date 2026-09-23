# imap2gmail

Ersetzt den Gmail-POP-Abruf („E‑Mails von anderen Konten abrufen“, deaktiviert ab 2026/2027)
durch einen eigenen Dauer-Container:

**Quell-IMAP abholen → nach Gmail APPEND → Quell-Mail wirklich löschen → optional ntfy.**

Technik: TypeScript + [imapflow](https://github.com/postalsys/imapflow)
(IDLE-Dauerbetrieb, Raw-Stream, `messageAppend`, Flags + Expunge).

## Architektur

```
Quell-IMAP (Testkonto / inseco-Forward)          Gmail IMAP
┌──────────────────────────────┐               ┌──────────────────┐
│ imapflow: select INBOX       │               │ messageAppend    │
│ Catch-up: uid > lastUid      │──raw RFC822──▶│ (raw Buffer)     │
│ IDLE (autoIdle) + Fallback-  │               └──────────────────┘
│   Poll alle N Sek.           │                      │ bei Erfolg
│ State: uidValidity + lastUid │               Quelle: \Deleted +
└──────────────────────┬───────┘               EXPUNGE (wirklich weg)
                       │                              │
                       ▼                              ▼
                 state.json (/data)            ntfy HTTP-POST (optional)
```

### Ablauf

1. Quelle verbinden, INBOX selecten, `uidValidity` gegen State prüfen
2. Catch-up: alle `uid > lastUid` als rohen RFC822-Buffer holen
3. Pro Mail:
   - Gmail `messageAppend(INBOX, raw)`
   - Quell-UID `\Deleted` + Expunge
   - Fehler bei Append: kein State-Vorziehen, Retry
   - Fehler beim Löschen nach erfolgreichem Append: Gmail-Rollback (per Message-ID suchen und expungen)
   - State speichern → ntfy POST („Von – Betreff“)
4. IDLE: imapflow `autoIdle`; Event `exists` → Catch-up
5. Fallback-Poll alle `FALLBACK_POLL_SECONDS` (Safety-Net)
6. Reconnect: imapflow-Recovery + eigener Catch-up
7. Crash-Fenster Append↔Delete: `pendingUid` im State → beim Start gezielt nacharbeiten

### State (`/data/state.json`)

```json
{ "uidValidity": 123456, "lastUid": 98765, "pendingUid": null }
```

- Nach Neustart: nur `uid > lastUid` → keine Duplikate
- `uidValidity`-Wechsel: Reset + Nacharbeit der offenen UID

## Setup

### 1. Quell-IMAP-Testkonto anlegen

Neues IMAP-Testkonto (z. B. bei einem Provider Deiner Wahl). Später
Forwarding von `*@inseco.de` auf diese Adresse – **ohne Migration** von
Bestandsmails (IMAP-Konto leer, Gmail hat alles).

### 2. Gmail-App-Passwort

Google-Konto → Sicherheit → 2-Faktor → **App-Passwörter** anlegen
(<https://myaccount.google.com/apppasswords>).

### 3. `.env` anlegen

```bash
cp .env.example .env
# Werte eintragen
```

| Variable | Bedeutung |
|---|---|
| `SOURCE__HOST/PORT/EMAIL/PASSWORD` | Quell-IMAP |
| `GMAIL__EMAIL` / `GMAIL__APP_PASSWORD` | Gmail-Ziel (App-Passwort) |
| `GMAIL__HOST/PORT` | Default `imap.gmail.com:993` |
| `NTFY__TOPIC_URL` | z. B. `https://ntfy.sh/mein-topic`; leer = aus |
| `NTFY__BLACKLIST` | From-Adressen ohne ntfy (kommagetrennt), z. B. `user@example.org` |
| `FALLBACK_POLL_SECONDS` | Default `60` |
| `STATE_FILE` | Default `/data/state.json` |

### 4. Starten

```bash
docker compose up --build -d
docker compose logs -f
```

Lokal (ohne Docker):

```bash
npm install
npm run build
# .env in Environment laden, dann:
npm start
```

## Testablauf

1. Neues IMAP-Testkonto anlegen, `.env` füllen
2. `docker compose up --build`
3. Testmail ans Testkonto → Prüfung:
   - Mail in Gmail sichtbar
   - Testkonto-INBOX **leer** (gelöscht)
   - `data/state.json` inkrementiert
   - ntfy kommt (falls gesetzt)
4. Container neustarten → keine Doppelzustellung
5. Kurzer Netz-Abbruch → Reconnect + Catch-up ohne Verlust/Duplikat
6. Wenn es klappt: Forwarding `*@inseco.de` → Testadresse aktivieren

## Umstellung von Gmail-POP (manuell, nach erfolgreichem Test)

> **Wichtig:** Erst umschalten, wenn imap2gmail stabil lief – sonst droht
> ein Doppelabruf bis zur POP-Entfernung (Jan 2027).

1. Testphase wie oben abschließen
2. Forwarding `*@inseco.de` → Testadresse aktivieren
3. Altes POP-Konto in Gmail entfernen:
   **Einstellungen → Konten & Import → „E‑Mails von anderen Konten abrufen“**
   → Konto entfernen
4. Bereits importierte Mails bleiben in Gmail erhalten
   (Quelle: <https://support.google.com/mail/answer/16604719>)

Hintergrund: Google schaltet POP ab – seit Q1 2026 keine neuen Einrichtungen,
Bestandsnutzung bis Jan 2027, danach vollständige Entfernung.

## Entwicklung

```bash
npm run build   # tsc
npm run dev     # tsx src/index.ts
```

### Projektstruktur

```
imap2gmail/
├── src/
│   ├── index.ts     # Entry, Main-Loop, Shutdown
│   ├── config.ts    # Env-Vars
│   ├── state.ts     # JSON-State lesen/schreiben
│   ├── source.ts    # imapflow Quelle: connect, IDLE, fetch raw, delete
│   ├── sink.ts      # imapflow Gmail: messageAppend, Rollback
│   ├── relay.ts     # Catch-up, pending-UID, Fehler/Rollback, ntfy
│   └── ntfy.ts      # HTTP-POST (leere URL = aus)
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── PLAN.md
```

## Lizenz

MIT
