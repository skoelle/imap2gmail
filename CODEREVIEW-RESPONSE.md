# Antwort auf CODEREVIEW.md

## Runde 1 – „IDLE hängt ewig / Catch-up ohne Deadline / Fallback-Poll“

Commit: `37a5e67` (`fix: IDLE hard timeout with client rebuild, ETIMEOUT handling, forced shutdown`)

### 1. IDLE hängt ewig

**Teilweise berechtigt, aber übertrieben.** imapflow hat bereits `socketTimeout`
(5 min) → bei totem Server feuert der Timeout, NOOP schlägt fehl, `close()` und
die wartende `idle()`-Promise wird abgelehnt. „Für immer“ gibt es nicht
(höchstens ~10 min). Trotzdem als Sicherheitsnetz umgesetzt:

- `source.idle(timeoutMs)` läuft gegen ein hartes Timeout
  (`IDLE__TIMEOUT_SECONDS`, Default **600 s**).
- Bei Ablauf wird der Client **neu aufgebaut** (`replaceClient()`), sonst könnte
  die nächste `idle()` sofort zurückkehren → enge Schleife.
- Verworfene `idle()`-Promise wird abgefangen (kein unhandled rejection).

### 2. Catch-up ohne Deadline / Prozess nicht kippbar

**Übertrieben bzw. teils falsch.** Jeder IMAP-Befehl hat ebenfalls den
5-min-`socketTimeout`. `Promise.race` auf `runOnce` wurde bewusst **nicht**
umgesetzt: der Hintergrund-Lauf bricht durch ein Race nicht ab → paralleler
State-Zugriff → Riss-Gefahr. Stattdessen:

- Warnung im Log, wenn ein Catch-up > 5 min dauert.
- Bestehender `busy`-/`rerun`-Mechanismus verhindert bereits parallele Läufe.
- „Nicht kippbar“ ist **falsch** (SIGTERM-Handler liefen), aber: hängendes
  `logout()` verzögerte den Exit → **Force-Exit nach max. 5 s** beim Shutdown.

### 3. Fallback-Poll läuft nur wenn IDLE retourniert

**Falsch.** `setInterval` läuft unabhängig vom `await source.idle()` der
Hauptschleife. Kein Code-Change.

### Weitere Änderungen Runde 1

- `ETIMEOUT` in `isConnectionGone()` → Socket-Timeouts lösen ebenfalls
  Reconnect + ntfy-Alert aus.

---

## Runde 2 – neue Punkte (Critical/High/Medium)

### Umgesetzt

| Punkt | Bewertung | Fix |
|---|---|---|
| **#6 ntfy `fetch` ohne Timeout** (P0) | Echt – hängender POST blockiert die Pipeline | `AbortSignal.timeout(10_000)` in `Ntfy.post()` |
| **#5 `fetchFrom` lädt alles in den RAM** (P0) | Echt bei großem Backlog (z. B. Erstlauf) | Batching: `fetchFrom(minUid, limit)` mit `FETCH_BATCH_SIZE = 100`; `processFolder` läuft in Schleife, early break ist bei imapflow sauber abgefangen (`finally`-Drain); Stagnations-Wächter (`catch-up stalled`) |
| **#3 `StateStore` sync I/O** (P0) | Echt (Event-Loop-Blockade bei I/O-Stall) | `load()`/`save()` auf `node:fs/promises`; alle `Relay`-Helfer (`saveFolder`, `loadFolder`, `clearFailed`, `advanceLastUid`) async + überall `await`; tmp+rename bleibt atomar (Crash-safe: force-exit vor `rename` → alter State unverändert, `pendingUid`+`hasMessageId` deduplizieren) |
| **#4 unbounded `failed`-Queue** (P1) | Echt (Endlos-Retries sind Absicht, aber Queue-Wachstum nicht) | Safety-Valve `MAX_FAILED_ENTRIES = 500`: älteste (niedrigste UID) werden verworfen mit Warnung; **Mail bleibt auf Source** (kein Datenverlust), da `lastUid` die Queue ohnehin vorzieht |
| **#9 kein Health-Endpoint** (P1) | Sinnvoll, aber optional | Opt-in `HEALTH__PORT` (unset = aus) + `HEALTH__STALE_SECONDS` (Default 900): `:PORT/healthz` → `200` solange letzter voller Catch-up jung genug, sonst `503`. Damit erkennt ein Orchestrator „läuft, verarbeitet aber nicht“. **Kein** Compose-Healthcheck ergänzt (bewusste Bestandsentscheidung). |
| **#10 Timer-Leak in `idle()`** | Review selbst: korrekt, kein Leak | nichts zu tun |
| **#12 `intEnv` ≤ 0** | Review selbst: korrekt | nichts zu tun |
| **#13 `pendingUid`-Logik** | Review selbst: korrekt | nichts zu tun |

### Bewusst nicht umgeszt / mit Begründung

| Punkt | Grund |
|---|---|
| **#2 Shutdown State-Korruption** (P1) | tmp+rename ist atomar; **synchrone** Saves waren ohnehin erst nach Abschluss zurück – bei async gilt dasselbe (Rename entweder passiert oder nicht). Restrisiko: eine State-Version „alt“, was durch `pendingUid` + Gmail-`hasMessageId`-Dedup abgefangen wird. Das `sleep(100)` bleibt als kurzer Settle. |
| **#1 IDLE-Erkennung bis ~10 min** | Absicht: Fallback-Poll (60 s) versucht sofort, scheitert aber erst nach `socketTimeout`; Alarm kommt ohnehin über `RECONNECT__ALERT_SECONDS`. Kein weiterer Change sinnvoll. |
| **#7 `rerun` ohne Debounce** | Review: „kein Hang“. Das Busy/Rerun-Coalescing ist bereits das korrekte Muster (Burst → genau ein Nachlauf). |
| **#8 `run()` nur 1 Retry** | `ensureConnected` ist durch imapflow-`socketTimeout` + OS-TCP-Begrenzung (~2 min) und den Hauptloop-Backoff (3–60 s) bereits abgedeckt; weiteres Retry im `run()` verändert nur, wer den Fehler zählt. |
| **#11 `onError` nur Log** | imapflow ruft bei fatalen Fehlern `emitError` → `close()` → die laufende `idle()`-Promise lehnt ab → Hauptloop reagiert bereits. Proaktives `replaceClient()` bei jedem `error` wäre riskanter (auch nicht-fatale Fehler). |
| **#14 Non-Root-User** (P2) | **Deploy-Risiko:** Compose nutzt Bind-Mount `./data:/data` (host-seitig root-owned) → `USER node` könnte `state.json` nicht schreiben und den Betrieb brechen. Nur mit Passwort-/Rechte-Plan des Hosts umsetzbar – Entscheidung nötig. |
| **#15 SIGUSR2 / Reload** | Kein Bedarf (Config-Änderung = Neustart). |
| **#16–#19 Code-Quality** | Review selbst als akzeptabel eingestuft. |
| **#20 Tests** | Valider Punkt, aber eigener Aufgabenblock (Test-Framework wählen, Cases festlegen) – auf Wunsch separat. |
| **#21 Compose/Healthcheck** | `docker-compose.yml` existiert (Review hat es nicht gesehen): `restart: unless-stopped`, **kein** Healthcheck – bewusst; bei Bedarf jetzt über `HEALTH__PORT` nachrüstbar. |
| **#22 State-Volume** | `./data:/data` ist gemountet, `STATE_FILE=/data/state.json` – erfüllt. |

### Neue Env-Variablen (Runde 2)

| Variable | Default | Bedeutung |
|---|---|---|
| `HEALTH__PORT` | aus (unset) | Gesundheits-Endpoint `:PORT/healthz` |
| `HEALTH__STALE_SECONDS` | `900` | `503`, wenn letzter voller Catch-up älter |

Konstanten in `relay.ts`: `MAX_FAILED_ENTRIES = 500`, `FETCH_BATCH_SIZE = 100`.
