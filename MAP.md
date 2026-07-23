# EchoLink — Code Map

> Lebendige Karte des Projekts. Stand: 2026-07-23. Bei größeren Umbauten aktualisieren.
> Zeilenzahlen sind Richtwerte — sie veralten. Muster und Verantwortlichkeiten bleiben.

## Überblick

EchoLink ist eine selbst-gehostete Chat-App (KI-Assistant mit Tools) für einen einzelnen
Hetzner-Server. Node/Express-Backend + React/Vite-Frontend + SQLite (better-sqlite3).
Läuft unter PM2 als `echolink` auf 127.0.0.1:3000 (siehe ecosystem.config.cjs).

```
┌ React-Client (dist/, gebaut aus client/) ── fetch + SSE ──┐
│ Express server/index.js :3000                              │
│  ├─ routes/* (REST + SSE-Streaming)                        │
│  ├─ lib/* (Tools, Scheduler, Memory, Push, AgentRunner)    │
│  ├─ providers/* (Ollama, Anthropic, Z.ai, Kimi, OpenAI)    │
│  ├─ connectors/google/* (Calendar, Gmail, OAuth)           │
│  └─ db.js → data/echolink.db (+ data/sessions.db)          │
├─ worker.js (separater PM2-Prozess: geplante Tasks, Push)   │
└─ Externe Dienste: SearXNG :8080, Firecrawl :3002, Ollama   │
```

## Start & Betrieb

- **Dev**: `npm run dev:server` (Backend) + `cd client && npm run dev` (Vite)
- **Prod**: `npm run build` (baut client → dist/), dann `pm2 restart echolink`
- **Deploy-Skript**: `scripts/deploy.sh` (= `npm run deploy`)
- **Tests**: `npm test` (= node --test tests/*.test.mjs) — Smoke/Unit, kein Framework
- **User anlegen**: `npm run adduser`
- **DB-Backup**: `scripts/backup-db.sh` (+ systemd-Timer in systemd/), Vollbackup: export-full-backup.sh
- **Env**: `.env` via server/loadEnv.js (MUSS erster Import in index.js/worker.js bleiben).
  PM2-env hat Vorrang vor .env. Wichtigste Vars: SESSION_SECRET, ECHO_API_KEY,
  BRIEFING_CONVERSATION_ID, DEFAULT_MODEL, SEARXNG_URL, FIRECRAWL_URL, ZAI_API_KEY,
  MOONSHOT_API_KEY, ANTHROPIC_API_KEY, GOOGLE_*, REDDIT_*, VAPID_*, MEMORY_DEBUG,
  TRUST_PROXY.

## Backend — Kern

### server/index.js (~223 Z.)
App-Einstieg. requestLogger (JSON-Zeilen mit requestId, loggt NUR Pfade, keine Query),
express-session mit connect-sqlite3 Store (data/sessions.db, Cookie `echolink.sid`,
7 Tage, rolling), JSON-Limit 5mb, mountet alle /api/*-Routen, 404-JSON für unbekannte
API-Routen, zentraler Error-Handler, serviert dist/ statisch (assets mit Cache-Header,
SPA-Fallback auf index.html). TRUST_PROXY nur hinter Reverse-Proxy.

### server/db.js (~657 Z.)
better-sqlite3, WAL. Export: `db` (default) + `DEFAULT_MODEL` (env, Fallback glm-5.1:cloud).
Tabellen:
- `users` (id, username, password_hash bcryptjs, default_system_prompt, memory[legacy])
- `conversations` (user_id, title, model, system_prompt, reasoning_effort, archived_at)
- `messages` (conversation_id, role, content, images JSON, usage JSON, think, source_task_id)
- `file_extractions` (Cache extrahierter Datei-Inhalte)
- `scheduled_tasks` (title, prompt, schedule_kind once|interval|cron, schedule_value,
  timezone, task_type reminder|agent, enabled, retention_days, next_run_at, lock-Felder)
- `task_runs` (status, phase, plan JSON, current_step, progress, control_state)
- `task_run_events` (Event-Log pro Run — Treibstoff für AgentRunCockpit)
- `push_subscriptions` (Web-Push-Endpunkte pro User)
- `google_oauth_accounts` (Tokens, Scopes, primary-Flag)
- `memory_items` (type, scope, status, content, importance, confidence, Fingerprints)
- Shift-System: `shift_imports`, `shift_import_items`, `shift_import_pages`,
  `shift_calendar_events`, `shift_sync_runs`, `shift_sync_actions`, `shift_settings`
Migrationen: defensive try/catch ALTER TABLEs beim Boot.

### server/middleware/auth.js
`requireAuth` (Session) + `requireApiKey` (Header gegen ECHO_API_KEY, für /api/external).

## Backend — Chat-Fluss (das Herz)

### Phase 2A — Sitzungs-Checkpoints (Webrecherche fortsetzen)
`server/lib/chatCheckpoints.js` normalisiert, begrenzt und dedupliziert abgeschlossene
`web_search`- und `firecrawl_scrape`-Resultate. Der Chat-SSE-Stream liefert sie als
`checkpoint` im bestehenden `tool`-Event; `Chat.jsx` hält sie im laufenden
`chatRun`-React-State und reicht neu empfangene Checkpoints auch bei automatischen
SSE-Reconnects weiter. Nach serverseitigem Stop zeigt `ChatAgentCockpit` **„Fortsetzen
ab X Checkpoints“** und sendet denselben Prompt mit `resumeCheckpoints`. `chat.js`
verwendet diese im Prompt-Kontext und in einem pro Lauf aufgebauten Cache, damit identische
Recherche nicht erneut extern ausgeführt wird. Keine DB-Tabelle, keine geplante Task; bei
Browser-Vollreload sind die Checkpoints absichtlich weg. Test: `tests/chatCheckpoints.test.mjs`.

### server/routes/chat.js (~2275 Z., größte Datei)
**`POST /api/chat/:conversationId`** (Z. ~791): SSE-Stream. Ablauf:
1. validateChatBody, Convo-Ownership prüfen
2. URLs in User-Message extrahieren → fetchAllUrls (lib/fetchUrl.js) → urlContext
3. User-Message speichern (außer skipSave/regenerate)
4. Memory-Kontext: selectMemoryItemsForContext + formatMemoryItemsForPrompt (lib/memoryItems.js)
5. System-Prompt zusammenbauen: convo.system_prompt + RULES.md (immer!) + Memory +
   Skills-Index (SKILLS_DIR=/root/echolink/skills, description-Zeilen) + urlContext + Zeit
6. Tool-Loop (MAX_TOOL_ITERATIONS=25): Modell streamt, tool_calls werden ausgeführt:
   - web_search / firecrawl_scrape → `readOnlyWebRuntime.js`; konfigurierte Reddit-Threads
     werden vor MCP/Firecrawl über den read-only OAuth-Reader geladen. Bei Fortsetzung wird
     ein flüchtiger Checkpoint-Cache aus dem Request verwendet, identische Suchanfrage/URL
     läuft nicht erneut
   - terminal → Auto-Approve-Allowlist (SAFE_PATTERNS, UNSAFE_META-Regex blockt
     Shell-Metazeichen) ODER actionRequest ans Frontend. Jeder Lauf wird dauerhaft in
     `chat_terminal_operations` protokolliert; freigegebene Befehle laufen über den
     abgekoppelten Runner `scripts/run-terminal-operation.js`
   - calendar/gmail-Write-Tools → actionRequest mit Preview (pendingCalendarActions /
     pendingGmailActions Maps), Ausführung erst nach Approve-Endpoint
7. Token-Streaming durchreichen; am Ende usage + context in `done`
8. Memory-Update: alle 10 Messages oder bei force (import memory.js → extractMemory)

**SSE-Protokoll** (`data: {json}\n\n`, HEILIGE Felder — nie umbenennen):
`{token}`, `{think}`, `{tool, status: running|done, query, ...}`, `{actionRequest: true, ...}`,
`{checkpoint: {name, args, result, key}}` (nur fertige web_search/firecrawl_scrape-Resultate),
`{error}`, `{done: true, context, tokens}`.

Weitere Endpunkte: `POST /:conversationId/cancel` (requestId-basiert, lib/chatCancellation.js),
`POST /models/list` (Z. ~2196 — Aggregat aus Ollama + konfigurierten Cloud-Providern;
einmal durch Refactoring gebrochen, vorsicht), `GET /stats` (Token-Usage), `POST /allowlist`
(Terminal-Freigaben), `GET|POST /memory` (Chat-bezogene Memory-Views).

### server/lib/chatCancellation.js (~120 Z.)
Registry aktiver Chat-Requests (userId+conversationId+requestId → AbortController).
register/unregister/cancel/assertActive. In-Memory — pro Prozess.

### server/lib/chatCheckpoints.js
Phase 2A für das **normale Chat-Cockpit**: normalisiert maximal 24 abgeschlossene
`web_search`-/`firecrawl_scrape`-Resultate, erzeugt stabile Schlüssel (Search-Query
whitespace/case-normalisiert; Scrape-URL ohne Fragment) und formatiert sie als
Continuation-Kontext. Keine DB und keine Task: Checkpoints leben nur im React-Run-State und
werden beim Fortsetzen als `resumeCheckpoints` im POST-Body übergeben. Der Server injiziert
die Resultate in den temporären Modellkontext und gibt bei gleichen Tool-Argumenten den
Cache zurück, statt die externe Suche/Scrape erneut auszuführen. Vollständiges Reload leert sie.

### server/lib/terminalOperations.js
Durabler Handoff für Terminal-Tools. Operationen sind über `request_id` und, sofern vorhanden,
`tool_call_id` an den Chat-Lauf gebunden. SQLite erzwingt den Übergang `queued → running`
atomar, damit ein wiederholtes Approve, ein Reconnect oder die Startup-Recovery denselben
Befehl nicht doppelt ausführt. Freigegebene Befehle laufen in einem detached Node-Prozess und
überleben dadurch `pm2 restart echolink` sowie `npm run deploy`. Ergebnis und Status werden
vor der Modellfortsetzung gespeichert; beim Reconnect wartet der SSE-Stream mit Heartbeats
und injiziert anschließend ein ausdrückliches „bereits ausgeführt, nicht wiederholen“-Ledger.
Tests: `tests/terminalOperations.test.mjs`.

## Backend — Provider (server/providers/)

- **ollama.js** (~88 Z.): streamOllama gegen OLLAMA_URL, nativer /api/chat, `think:false`
  bei reasoningEffort=off, mappt message.content→`{token}` und message.thinking→`{think}`.
- **openai-compatible.js** (~168 Z.): Z.ai (api.z.ai) + Kimi (api.moonshot.ai) über
  Chat-Completions; toOpenAI() konvertiert internes Format (tool_calls-Ids werden
  generiert call_gen_N_M); splitSystemTimeNote Hilfsfunktion.
- **anthropic.js** (~245 Z.): streamAnthropic, Messages-API, System getrennt.
- **openai-responses.js** (~153 Z.): streamResponses, OpenAI Responses-API.
- **ollamaVision.js / openaiVision.js**: Bild→Text für Uploads/Shift-Imports/PDFs.
- Modell→Provider-Routing: Präfixe `claude*`=Anthropic, `zai/…`, `kimi/…`, sonst Ollama.
  In chat.js UND agentRunner.js (providerFor) doppelt — bei neuen Providern BEIDE anfassen.

## Backend — Tools (server/lib/)

- **toolRegistry.js**: ALL_TOOLS = Search+Firecrawl+Terminal + Calendar + CalendarExtra +
  Gmail + Task. Einzige Stelle, an der Tools registriert werden.
- **webSearch.js**: web_search (SearXNG :8080, 10s Timeout, 5 Results), firecrawl_scrape
  (Firecrawl :3002), TERMINAL_TOOL-Definition. linkedAbortController(Timeout+extern).
- **redditReader.js**: opt-in Reddit-OAuth-Reader für kanonische `/comments/`-, `redd.it`-
  und `/s/`-Share-Links. App-only Token wird gecacht und bei 401 einmal erneuert; feste
  Reddit-Endpunkte, `read`-Scope, eindeutiger User-Agent, Rate-Limit-/Timeout-Behandlung.
  Post und maximal 100 Kommentare werden begrenzt und als untrusted User-Content markiert.
- **calendarTools.js**: list/get/create. create geht als Approval-Preview raus.
- **calendarExtraTools.js** (~764 Z.): update/delete/find_free_time + Preview-Formatierung.
- **gmailTools.js** (~1015 Z.): search/read/thread/drafts/attachments/extract/download-link/
  send+delete (beide approval-pflichtig).
- **taskTools.js**: create/list/update/delete/run_task_now für scheduled_tasks.
- **fetchUrl.js**: extractUrls + fetchAllUrls (Auto-Fetch von URLs aus User-Text);
  aktive Reddit-Thread-Links gehen zuerst über redditReader.js.
- **images.js / utils/image.js**: sharp-Resize (sharp = "der Vorfall"; in package.json!).

## Backend — Tasks & Agenten

### server/worker.js (~699 Z., eigener PM2-Prozess)
Poll-Loop (TASK_POLL_MS, default 30s): fällige enabled Tasks mit DB-Lock (5min Timeout,
Heartbeat) abarbeiten, max 25/Tick. recoverInterruptedRuns() beim Start (running→failed).
- **reminder**: Text in dedizierte Conversation + Push
- **agent**: runScheduledAgent() → frische Antwort mit ReadOnly-Tools, dann Push
- completeTask/failTask berechnen next_run_at via lib/scheduler.js
- pruneTaskMessages (retention_days), taskCleanup-Intervall, graceful shutdown.

### server/lib/agentRunner.js (~513 Z.)
runScheduledAgent: eigene Tool-Loop NUR mit READ_ONLY_TOOLS (search+firecrawl),
MAX_TOOL_ITERATIONS=16, MAX_TOOL_CALLS=24, 6min Timeout, Control-Polling alle 750ms
(Pause/Cancel via task_runs.control_state), AgentRunCancelledError, Finalisierung
ohne Tools. systemPrompt(task) + localDateTime('de-AT', Europe/Vienna).

### server/lib/
- **scheduler.js**: normalizeSchedule/validate/computeNextRunAt (cron-parser), TZ-Validierung.
- **taskRunState.js**: createTaskRun/updateTaskRun/appendTaskRunEvent/finishTaskRun/defaultAgentPlan.
- **taskConversations.js**: createDedicatedTaskConversation (eigene Convos für Agent-Tasks).
- **taskCleanup.js**: alte Runs/Events aufräumen.
- **push.js**: web-push VAPID, sendPushToUser, prune kaputter Subscriptions.

### server/routes/tasks.js (~675 Z.)
CRUD für scheduled_tasks, run-History, run-Details mit Events, enable/disable, run-now.
Frontend: TaskPanel.jsx + AgentRunCockpit.jsx.

## Backend — Memory

- **lib/memoryItems.js** (~935 Z.): Strukturiertes Memory. Types: profile|preference|
  project|instruction|episodic|temporary|persona|legacy|fact. Status: active|superseded|
  archived. selectMemoryItemsForContext (Scoring/Retrieval, limit 10, 6000 chars),
  formatMemoryItemsForPrompt.
- **routes/memory.js** (~921 Z.): CRUD /api/memory/items + extractMemory(userId, convoId,
  model) — ruft runMemoryModel (JSON-Extraktion aus Verlauf), Dedup via Fingerprint/
  Token-Ähnlichkeit (findSimilarMemory), applyStructuredMemories. Legacy: users.memory-Text
  + /save + /update/:conversationId. MEMORY_DEBUG=1 loggt Auswahl.
- Frontend: MemoryPanel.jsx.

## Backend — Google

- **connectors/google/oauth.js**: OAuth-Flow, Token-Refresh, Multi-Account.
- **connectors/google/calendar.js / calendarExtra.js**: API-Wrapper (list/get/create vs.
  update/delete/freebusy).
- **routes/google.js**: /api/google/status, /oauth/start, /oauth/callback, /disconnect,
  /events, Kalender-Liste. Frontend: SettingsPanel.

## Backend — Shift-System (Schichtplan-Import für Novartis-Dienstplan)

Pipeline: Foto/PDF des Dienstplans → Vision-OCR → Prüf-UI → Google-Calendar-Sync.
- **routes/shiftImports.js**: Einzelbild-Import (analyze → items → import).
- **routes/shiftMultipage.js** (~1244 Z.): Mehrseitige PDFs, /merge, /discard, pages.
- **routes/shiftSync.js** (~1803 Z.): Diff gegen Google Calendar (create/update/delete),
  SHIFT_TITLES früh/spät/nacht, Sync-Runs mit Actions-Protokoll.
- **routes/shiftSettings.js**: Codes→Zeiten (1=Früh 04-12, 2=Spät 12-20, 3=Nacht 20-04),
  Ziel-Kalender-Auswahl.
- **routes/shiftHistory.js**: Vergangene Imports/Syncs, Bilder, Archiv, Cleanup.
- Frontend: ShiftImporter.jsx (2442 Z.!), ShiftHistory.jsx, ShiftSettings.jsx.

## Backend — Sonstige Routen

- **auth.js**: login (Rate-Limited, bcryptjs), logout, /me, default-prompt get/patch.
- **conversations.js**: CRUD, Archiv/Restore, Suche, Messages, Edit/Delete einzelner
  Messages, delete last-assistant (Regenerate-Support).
- **uploads.js** (~387 Z.): multer nach data/uploads/<userId>/, 100MB, Bilder+Text+PDF;
  extractTextFromFile (pdf-parse, mammoth docx, xlsx, sonst plain); cleanupOrphanedFiles.
- **external.js**: POST /api/external/briefing + GET /health, beide API-Key-geschützt;
  schreibt Briefings als Assistant-Message in BRIEFING_CONVERSATION_ID.
- **system.js** (~325 Z.): Systemstatus-Endpunkt (SystemStatusPanel.jsx).
- **push.js**: VAPID-Key, subscribe/unsubscribe, Test-Push.
- **utils/pdfVision.js**: PDF-Seiten rendern → Vision-Transkription (Gmail-Attachments,
  Shift-PDFs).

## Frontend (client/src/)

- **main.jsx → App.jsx**: Theme, WakeLock, /api/auth/me → Login | Chat.
- **pages/Chat.jsx** (~2680 Z.): Der ganze Chat: Sidebar-State, SSE-Konsum (fetch +
  ReadableStream, KEIN EventSource), actionRequest→Approve/Deny-UI, Cancel, Regenerate,
  Model-Wahl, Reasoning-Effort, Uploads, Kontext-Budget-Anzeige. Nimmt SSE-Checkpoints in
  den aktuellen `chatRun` auf und sendet sie beim Fortsetzen wieder an den Server.
- **pages/Login.jsx**: Login-Form.
- **lib/api.js**: fetch-Wrapper mit apiError (HTML-Fehlerseiten werden verschluckt).
- **lib/chatRunState.js**: Heuristik, ob ein Prompt „agentisch" wirkt (für UI-Hinweise);
  trägt außerdem nur im RAM `requestContent` und deduplizierte Research-Checkpoints eines
  normalen Chat-Runs.
- **lib/push.js**: SW-Registrierung + Subscription. **lib/templates.jsx**: Avatar-SVGs
  (corsn/echo/dev...).
- **components/**: Message.jsx (Markdown, Tool-Blöcke, Terminal-Bündelung), MessageInput,
  Sidebar, SettingsPanel, MemoryPanel, TaskPanel, AgentRunCockpit (Run-Detail mit Plan/
  Events), ChatAgentCockpit (bei abgebrochenem Research-Run: „Fortsetzen ab X Checkpoints“),
  TerminalTimeline (**Terminal:**-Messages), SystemStatusPanel,
  ShiftImporter/ShiftHistory/ShiftSettings, PushButton, ThemePicker, AppToolsMenu,
  LunaMiniHud (Luna-Status), **CorsnFace.jsx** (das Wesen in den Drähten: moods
  ok|focus|wink|sleepy|panic + Aktivitäts-Symbole pro Tool).
- **client/public/**: manifest.json, sw.js (Service Worker für Push), Icons.

## Daten & Dateien (data/)

- `data/echolink.db` — „die Kleine", Haupt-DB (WAL)
- `data/sessions.db` — Session-Store
- `data/uploads/<userId>/` — Chat-Uploads
- `data/shift-imports/` — Schichtplan-Bilder/PDFs

## Tests (tests/)

node:test, 7 Dateien: smoke, scheduler, chatCancellation, chatRunState, memorySyntax,
taskCleanup, taskRunState. `npm test`. Kein Client-Testsetup.

## Skills (skills/)

skills/<name>/SKILL.md mit YAML-Frontmatter (name, description, trigger). chat.js baut
beim System-Prompt einen Index (description-Zeilen). Aktuell: fable-method.
Neue Skills: Ordner + SKILL.md anlegen, fertig — kein Code nötig.

## Sicherheits-/Integritäts-Regeln (aus RULES.md + Code-Konventionen)

1. SSE-Feldnamen (token, think, done, error, actionRequest, tool, status) HEILIG —
   Frontend hängt dran; Server+Client immer zusammen ändern.
2. Nach Backend-Edit: node --check → pm2 restart echolink → Testchat (Stream prüfen).
3. Terminal-Auto-Approve nur via SAFE_PATTERNS; UNSAFE_META erzwingt Approval.
   Nie erweitern ohne Grund.
4. .env niemals in Zips/Git. Secrets nur dort, nicht in ecosystem.config.cjs.
5. npm install immer in /root/echolink (package.json!), danach restart +
   `pm2 logs echolink --err --lines 10 --nostream` auf ERR_MODULE_NOT_FOUND.
6. Keine Routen/Exports/Helper löschen ohne Projekt-weites grep (inkl. client/src).
   Opfer der Vergangenheit: /models/list, updateMemory, urlContext-Formatter.
7. requestLogger loggt keine Query-Strings (Tokens!). Beibehalten.
8. Session-Cookie secure nur hinter HTTPS-Proxy (COOKIE_SECURE=true).

## Typische Fallstricke

- `patch_kimi.py` im Root: Ad-hoc-Patchskript, kein Teil des Builds.
- Provider-Routing existiert in chat.js UND agentRunner.js — doppelt pflegen.
- backups/ (34 Ordner) sind manuelle Snapshots, kein Git-Ersatz, nicht löschen ohne Absprache.
- RULES.md.bak ist absichtlich da.
- dist/ ist Build-Artefakt — niemals direkt editieren.
- Chat.jsx und ShiftImporter.jsx sind Monster-Dateien; Änderungen chirurgisch, nie „neu schreiben".

### Kimi-Provider
Kimi läuft über `server/providers/openai-compatible.js`, Modellpräfix `kimi/`; K3 nutzt `reasoning_effort`, Sampling-Parameter bleiben wegen fester Providerwerte weg. Bei Tool-Loops `reasoning_content` bewahren.
