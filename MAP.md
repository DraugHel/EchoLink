# EchoLink — Code Map

> Lebendige Karte des Projekts. Stand: 2026-08-06. Bei größeren Umbauten aktualisieren.
> Zeilenzahlen sind Richtwerte — sie veralten. Muster und Verantwortlichkeiten bleiben.

## Pflege-Regel für Luna/E3

- Vor jedem EchoLink-Source-Change zuerst diese `MAP.md` lesen und als Karte für
  die anschließende gezielte Source-Inspektion verwenden.
- Wenn ein Change Projektstruktur, Komponenten-Verantwortung, Routen/Services,
  Betriebs- oder Deploypfade oder andere Aussagen dieser Karte materiell ändert,
  `MAP.md` im selben E3-Change passend aktualisieren.
- Reine Implementierungsdetails, die keine Aussage dieser Karte verändern,
  erzeugen kein künstliches `MAP.md`-Update.

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
  MOONSHOT_API_KEY, DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, GOOGLE_*, REDDIT_*, VAPID_*, MEMORY_DEBUG,
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

### server/e3/core/
Reine Domänenlogik der EchoLink Editor Engine, noch ohne Runtime-Anbindung:
- **contracts.js**: kanonische Sessionzustände, Commands, Eventtypen,
  Fehlercodes und Validatoren für UUID, vollständigen Git-SHA, SHA-256,
  Version und Fencing-Token.
- **sessionState.js**: eingefrorene Session-Erzeugung und zentrale
  V1-Zustandsmaschine. Jede Transition prüft Session-ID, erwartete Version,
  Lease-Owner und Fencing-Token. Review-, Approval- und Exportnachweise sind
  hashgebunden; Mutation oder Reopen invalidiert sie. Produktiver Apply und
  Revert sind reserviert, aber fail-closed deaktiviert.

Kein Modul unter `server/e3/core/` greift auf Dateisystem, SQLite, Netzwerk,
Prozesse, Shell, Workspace oder UI zu. Test:
`tests/e3SessionState.test.mjs`.

### server/e3/persistence/
Isolierte Persistenzschicht der Editor Engine, noch ohne Runtime-Anbindung:
- **database.js**: öffnet ausschließlich auf expliziten Aufruf eine separate
  `editor.db`, erzwingt und verifiziert WAL, Foreign Keys, 5-s-Busy-Timeout
  und `synchronous=FULL`, führt checksummierte Migrationen unter exklusivem
  Lock aus und prüft die DB mit `quick_check`.
- **migrations/**: nummerierte, unveränderliche Schemahistorie. Migration 001
  erzeugt Sessions, Operationen, append-only Events, Validierungsläufe,
  Artefaktmetadaten, Leases und Idempotency-Keys mit Domänen-Constraints.
  Migration 002 ergänzt die gefencte Workspace-Identität und ihren
  Lebenszyklus.
- **editorRepository.js**: transaktionale Session-Erzeugung und Transitionen,
  optimistische Versionen, Request-ID-Replay, atomare Operationsjournale und
  Kandidateninvalidierung sowie Fencing-geschützte Lease-Claims.
- **errors.js**: stabile Fehlercodes der Persistenzgrenze.

Die Persistenzmodule werden weder von `server/index.js` noch `server/worker.js`
importiert und verändern daher beim normalen Start weder die bestehende
Anwendungsdatenbank noch den Runtime-Betrieb. Test:
`tests/e3Persistence.test.mjs`.

### server/e3/workspaces/
Read-only Workspace Manager der Editor Engine, weiterhin ohne
Runtime-Anbindung:
- **workspaceManager.js**: erzeugt, prüft und entfernt genau einen
  sessiongebundenen Workspace unter aktuellem Lease und Fencing-Token.
- **workspaceGit.js**: verwendet ausschließlich `/usr/bin/git` ohne Shell,
  Credentials oder gespeicherte Remotes; verwaltet einen dedizierten Bare-
  Mirror und exakte detached Worktrees aus dem vertrauenswürdigen lokalen
  `main`.
- **paths.js / managerLock.js**: kanonische UUID-Pfade, erneut geprüfte
  Manager-Verzeichnisse und atomare Mirror-/Workspace-Locks.
- **workspaceManifest.js / treeScanner.js**: atomar publiziertes, SHA-256-
  gebundenes Manager-Manifest sowie begrenzte Größen-/Eintragsprüfung ohne
  Symlinks zu verfolgen.
- **workspaceRepository.js**: transaktionale Workspace-Metadaten und
  wiederaufnehmbarer `READY → REMOVING → REMOVED`-Cleanup.

Das Feature ist standardmäßig deaktiviert (`E3_WORKSPACE_ENABLED` muss exakt
`true` sein), wird weder von `server/index.js` noch `server/worker.js`
importiert und exponiert noch keine Dateioperation oder Prozess-API. Tests:
`tests/e3WorkspaceManager.test.mjs`.

### server/e3/editor/
Deterministischer Textdatei-Operationskern der Editor Engine, ohne
Runtime-Anbindung:
- **requestSchema.js / pathPolicy.js**: versionierte, geschlossene
  Operationsschemas und kanonische portable POSIX-Pfade; unbekannte Felder,
  Traversal, `.git`, Secrets, Datenbanken, Abhängigkeiten und generierte
  Ausgaben werden fail-closed abgewiesen.
- **safeTextFilesystem.js**: begrenzte UTF-8-Reads, deterministische Listen-
  und Suchergebnisse sowie atomare Same-Directory-Writes mit `O_NOFOLLOW`,
  `fsync`, Preimage-Recheck, Lease-Guard und Preimage-Retention.
- **editorKernel.js**: registriert `read_file`, `list_files`, `stat_file`,
  `search_text`, `create_file`, `replace_exact`, `insert_before`,
  `insert_after`, `rename_file`, `move_file` und `delete_file`.

Symlinks werden nie verfolgt, Hardlink-Mutationsziele werden abgewiesen und
`replace`/`insert` verlangen SHA-256 plus exakte Trefferanzahl. Das Feature ist
standardmäßig deaktiviert (`ECHOLINK_E3_EDITOR_ENABLED` muss exakt `true`
sein), schützt `/root/echolink` zusätzlich als Root-Grenze und wird weiterhin
weder von `server/index.js` noch `server/worker.js` importiert. Test:
`tests/e3EditorKernel.test.mjs`.

Sessiongebundene Mutationsschicht, weiterhin ohne Runtime-Anbindung:
- **operationIntentRepository.js**: persistiert
  `PREPARED → PUBLISHED → RECORDED` beziehungsweise
  `RECOVERY_REQUIRED`, bindet Request-Hash, Sessionversion, Workspacepfad und
  beide Fencing-Tokens und erzwingt Mutations-/Byte-Limits.
- **preimageStore.js**: inhaltsadressierter, SHA-256-verifizierter
  Preimage-Speicher mit atomarer Veröffentlichung und ohne Symlink-Following.
- **sessionEditorService.js**: orchestriert Planung, Intent, gesicherten
  Workspace-Publish, atomare DB-Aufzeichnung und explizite Crash-Recovery.
- Migration 003 ergänzt Operation-Intents und Preimage-Referenzen.

Die Integration wird in `tests/e3SessionEditorService.test.mjs` geprüft. Sie
exponiert keine Route oder Agent-API und besitzt weiterhin kein produktives
Apply.

### server/e3/artifacts/

Deterministische Kandidaten- und Undo-Artefakte, weiterhin ohne
Runtime-Anbindung:
- **artifactStore.js**: begrenzter, fsync- und SHA-256-gesicherter
  Content-Addressed Store mit verifizierter Deduplizierung.
- **candidateBuilder.js**: friert den Workspace über einen privaten
  alternativen Git-Index ein und erzeugt vollständiges Tree-Manifest,
  Forward-/Reverse-Patch, Unified Diff und begrenzten Diff-Stat.
- **candidateArtifactRepository.js**: veröffentlicht fünf Artefaktmetadaten
  und ihre Sessionversionsbindung atomar in SQLite.
- **candidateArtifactService.js**: prüft Leases/Fencing, blockiert offene
  Operation-Intents und verlangt zwei identische Freeze-Durchläufe.
- Migration 004 ergänzt unveränderliche Kandidaten-Artefaktsets.

Roundtrip, Reproduzierbarkeit, Manipulation, Race und Teilfehler werden in
`tests/e3CandidateArtifacts.test.mjs` geprüft. Schritt 7 besitzt kein
produktives Apply.

### server/e3/validation/

Fail-closed Zulassungsgrenze für isolierte Validierung, weiterhin ohne
Anbindung an bestehenden Server oder Worker:
- **contracts.js / errors.js**: versionierte Validierungsverträge, stabile
  Profil-IDs, Netzwerkmodi, Mountklassen, Runtime- und Ressourcenlimits.
- **profileRegistry.js**: unveränderlicher Katalog aus acht festen Profilen.
  Images müssen als SHA-256-Digests bereitgestellt werden; Entry-Point,
  Argumente, Mountklassen, User, Capabilities, Netzwerk und Limits sind
  vollständig brokerseitig festgelegt und gemeinsam hashgebunden.
- **requestSchema.js**: geschlossenes Requestschema. Der Aufrufer kann nur
  Run, Session, Candidate-Set, Manifest, Snapshot-Handle, Profil-ID/-Version
  sowie Lease/Fencing binden; unbekannte Ausführungsfelder werden abgewiesen.
- **environmentPolicy.js / validationPlanner.js**: baut eine neue
  Environment-Allowlist ohne Vererbung von `process.env` und erzeugt ein
  deterministisches, tief eingefrorenes Planmanifest mit Request-, Profilset-
  und Plan-SHA-256.

Schritt 8 führt noch keinen fremden Code aus und exponiert keine Route oder
Agent-API. Manipulations-, Secret-Leak-, Runtime-Drift- und
Arbitrary-Command-Versuche prüft `tests/e3ValidationPlanning.test.mjs`.

Schritt-9-Lifecycle, weiterhin default-off und ohne Runtime-Anbindung:
- **snapshotMaterializer.js**: rekonstruiert einen Kandidaten ausschließlich
  aus vertrauenswürdigem Bare-Mirror, exaktem Base-Commit und gebundenem
  Forward-Patch. Basis und Ergebnis werden gegen das vollständige
  Candidate-Manifest geprüft; Symlinks, Hardlinks, Sonderdateien,
  Grenzüberschreitungen und abweichende Hashes werden abgewiesen. Der
  veröffentlichte Baum enthält kein `.git` und wird hostseitig read-only.
- **dockerRuntime.js**: erzeugt ohne Shell einen festen Docker-Argumentvektor
  mit digestgepinntem Image, `--pull never`, Network/IPC `none`, read-only
  Root-FS, non-root UID/GID, Cap-Drop, No-New-Privileges sowie CPU-, RAM-,
  PID-, Datei-, Log-, Output- und Zeitlimits. Snapshot und Output sind die
  einzigen Bind-Mounts.
- **validationBroker.js**: ist standardmäßig deaktiviert, kompiliert den Plan
  erneut aus dem geschlossenen Request, bindet den abgeleiteten
  Snapshot-Handle und prüft den Kandidaten vor und nach der Laufzeit.
  Container- und Snapshot-Abwesenheit müssen nach Cleanup bewiesen sein;
  mehrdeutige Docker-Fehler gelten nicht als erfolgreicher Cleanup.

Schritt-14A.1-Trusted-Validation-Runtime, weiterhin operator-only und ohne
normale Runtime-Anbindung:
- **imageSources.js / imageManifest.js**: pinnt die exakten Node-/Playwright-
  Basemanifeste und verifiziert ein kanonisches, root-eigenes Manifest mit
  Git-Tree-, Source-, Lockfile-, Driver- und lokalen Image-ID-Bindungen.
- **docker/e3-validation/**: zwei digestgepinnt gebaute non-root Images und ein
  fester Driver für exakt die acht akzeptierten Profile. Der Driver nutzt
  keine Shell, verwirft fremde Environmentwerte, kopiert den Snapshot nur
  begrenzt unter `/e3/tmp` und blockiert fremde Browser-Origins.
- **scripts/e3-build-validation-images.sh**: argumentloser expliziter
  Root-Operatorlauf. Der Buildkontext entsteht aus einem privaten Git-Index,
  Images werden vollständig verifiziert und alle Profile durch die bestehenden
  realen Docker-Runtimes gesmoked. Erst nach nachgewiesenem Cleanup wird
  `/var/lib/echolink-e3/validation-images.json` veröffentlicht.
- **scripts/e3-validation-image-smoke.mjs /
  e3-write-validation-image-manifest.mjs**: fester realer Profilsmoke und
  atomare Manifestpublikation.
- **scripts/e3-prune-validation-storage.sh**: lock-geschützte Retention nach
  erfolgreichem Rebind. Sie schützt die aktive und genau eine vorherige
  Validator-Generation, entfernt ausschließlich ältere E3-Validator-Images
  und Rollback-Manifeste und leert den wegen `--no-cache` regenerierbaren
  Docker-Build-Cache. Aktive Images und fremde Docker-Images bleiben
  unangetastet.
- CI verwendet nun exakt Node `24.18.0`; Docker-Runtimes verlangen zusätzlich
  explizit `apparmor=docker-default`.

14A.1 aktiviert kein Feature-Flag, exponiert keine Route oder Agent-API und
implementiert noch keinen Operational Pilot Harness. Tests:
`tests/e3TrustedValidationRuntime.test.mjs`,
`tests/e3ValidationBroker.test.mjs`, `tests/e3UiValidationRuntime.test.mjs`.

Schritt-10-UI-Isolation:
- **dockerUiRuntime.js**: erstellt pro Lauf genau eine interne Docker-Bridge
  ohne veröffentlichte Ports sowie einen non-root Anwendungs- und einen
  non-root Browser-Container. Beide erhalten nur den eingefrorenen Snapshot;
  ausschließlich der Browser erhält den begrenzten Output-Mount und den
  exakten internen Ursprung `http://e3-app:4173`.
- Profilset V2 bindet beide digestgepinnten Images, feste Entry-Points,
  Rollen, Mountklassen und Ressourcenlimits. Hostnetwork, Host-Gateway,
  Docker-Socket, produktive Mounts, beliebige Origins und allgemeiner Egress
  bleiben ausgeschlossen.
- Beide Container und das Netzwerk werden nach Erfolg, Fehler, Timeout oder
  Teilstart zwangsweise entfernt. Mehrdeutiger Cleanup verhindert Erfolg.

Schritt 10 exponiert weiterhin keine Route oder Agent-API. Reale Container
werden in den Tests nicht gestartet; vollständige Lifecycle- und
Argumentvektoren werden über kontrollierte Runtime-Adapter geprüft:
`tests/e3ValidationBroker.test.mjs` und
`tests/e3UiValidationRuntime.test.mjs`.

Schritt-11-Review-Gate, weiterhin default-off und ohne Runtime-Anbindung:
- **review/contracts.js / errors.js**: feste V1-Review-Policy mit allen acht
  Pflichtprofilen, kanonische Manifeste, Policy-Hash und stabile Fehlercodes.
- **validationEvidenceService.js**: bindet jeden Broker-Lauf unveränderlich an
  Candidate, Profil, Profilset, Request und Plan. Logs sind begrenzt,
  content-addressed und werden mit append-only Evidenzmetadaten gespeichert.
- **reviewGate.js**: akzeptiert nur acht erfolgreiche, eindeutige Nachweise
  desselben Kandidaten und Profilsets. Kandidatenartefakte und Logs werden
  erneut gelesen und hashgeprüft. Validierungsmanifest, Review-Zusammenfassung,
  Review-Set, Event und `READY_FOR_REVIEW` werden atomar persistiert.
- Migration 005 ergänzt unveränderliche `editor_validation_evidence`- und
  `editor_review_sets`-Tabellen. Manipulation, fehlende Profile, gemischte
  Profilsets, stale Versionen/Fencing-Tokens, abgelaufene Leases und injizierte
  Teilfehler scheitern geschlossen.

Schritt 11 exponiert keine Route oder Agent-API und startet weder Container
noch Prozesse. Test: `tests/e3ReviewGate.test.mjs`.

Schritt-12-Approval-Gate, weiterhin default-off und ohne Runtime-Anbindung:
- **approval/contracts.js / errors.js**: feste V1-Approval-Policy,
  kanonische Zustimmungserklärung, Policy-Hash und stabile Fehlercodes.
- **approvalGate.js**: verlangt eine explizite, feldgenau gebundene
  `APPROVE`-Erklärung für Sessionversion, Base-Commit, Candidate, Review-Set,
  Validierungsmanifest, Review-Zusammenfassung, Profilset und beide Policies.
  Vor der Freigabe werden Kandidaten-, Review- und Validierungsartefakte erneut
  gelesen, kanonisch geprüft und SHA-256-verifiziert.
- Migration 006 ergänzt unveränderliche `editor_approval_records`.
  Approval-Datensatz, `SESSION_APPROVED`-Event und Übergang zu `APPROVED`
  werden atomar persistiert. Replays sind nur bytegenau identisch zulässig;
  konkurrierende oder widersprüchliche Freigaben scheitern geschlossen.

Schritt 12 exponiert keine Route oder Agent-API und aktiviert weder Export noch
produktiven Apply. Test: `tests/e3ApprovalGate.test.mjs`.

Schritt-13-Pilot-Export, weiterhin default-off und ohne Runtime-Anbindung:
- **export/contracts.js / errors.js**: feste V1-Exportpolicy, kanonische
  Manifestregeln, Policy-Hash, Größenlimit und stabile Fehlercodes.
- **deterministicTar.js**: erzeugt und prüft ein kanonisch sortiertes,
  unkomprimiertes USTAR-V1-Archiv mit festen Metadaten, Header-Prüfsummen,
  Nullpadding und genau zwei Abschlussblöcken.
- **pilotExportService.js**: verifiziert die aktuelle Approval-Linie erneut und
  exportiert Candidate-Manifest, Forward-/Reverse-Patch, Unified Diff,
  Diff-Stat, Review-Artefakte, Approval-Statement und alle acht
  Validierungslogs samt `SHA256SUMS` und Exportmanifest.
- Migration 007 ergänzt unveränderliche `editor_pilot_export_records`.
  Export-Artefakt, `EXPORT_STARTED`/`EXPORT_FINISHED`, beide Statuswechsel bis
  `EXPORTED` und Exportdatensatz committen in einer SQLite-Transaktion.
  Replays sind bytegebunden; manipulierte Quellen oder Pakete, stale
  Versionen, Lease-/Fencing-Abweichungen und Teilfehler scheitern geschlossen.

Schritt 13 exponiert keine Route oder Agent-API, führt keinen Produktiv-Apply
und startet keine Prozesse oder Container. Test: `tests/e3PilotExport.test.mjs`.

Schritt-14-Recovery/Reaper, weiterhin default-off und ohne Runtime-Anbindung:
- **recovery/contracts.js / errors.js**: feste V1-Recovery-Policy, geschlossene
  Requestfelder, kanonischer Policy-Hash, Entscheidungen, Gründe und stabile
  Fehlercodes. Unbekannte Pfade werden nie automatisch gelöscht oder verschoben.
- **recoveryRepository.js**: liest Workspace-/Session-Snapshots, laufende
  Validationen und offene Mutationsintents, übernimmt ausschließlich
  abgelaufene Session-/Workspace-Leases per CAS mit monotonem Fencing und
  speichert unveränderliche Recovery-Läufe und Einzelentscheidungen.
- **recoveryService.js**: serialisiert über den globalen Cleanup-Lock, gleicht
  DB, kanonische Workspace-Pfade und hashgebundene Manager-Manifeste ab, prüft
  Leases, Prozesse, Container, Ports und Retention und delegiert zulässigen
  Cleanup ausschließlich an den bestehenden `WorkspaceManager`. Mehrdeutige
  Fälle werden nur als `QUARANTINE_REQUIRED` protokolliert und behalten.
- **sessionFinalizer.js**: schließt einen exportierten Pilot erst nach
  nachgewiesenem Workspace-Cleanup über die bestehende zentrale Transition zu
  `COMPLETED` ab.
- Migration 008 ergänzt unveränderliche `editor_recovery_runs` und
  `editor_recovery_decisions`. Crashpunkte vor/nach Lease-Takeover, Cleanup,
  Sessionabschluss und Audit sind idempotent wiederaufnehmbar. Der aktuelle
  Lease-Token fencet Cleanup; der im unveränderten Workspace-Manifest gebundene
  Erzeugungs-Token bleibt dessen Identitätsnachweis.

Schritt 14 exponiert keine Route oder Agent-API, führt keinen Produktiv-Apply,
keinen Docker-Prune und keinen allgemeinen rekursiven Löschpfad aus. Tests:
`tests/e3RecoveryReaper.test.mjs`, `tests/e3WorkspaceManager.test.mjs`.

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
5. Stabilen System-Prompt aus convo.system_prompt + RULES.md (immer!) + Skills-Index
   (SKILLS_DIR=/root/echolink/skills, description-Zeilen) und Calendar-Policy bauen.
   Wechselnde Memory-Auswahl und aktuelle Zeit werden als vertrauenswürdiger
   Laufzeitkontext an die letzte User-Nachricht gehängt, damit sie den Provider-Cache-Prefix
   nicht bei jedem Turn invalidieren
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
7. Token-Streaming durchreichen; Usage über alle Tool-Iterationen summieren und am Ende
   zusammen mit context in `done` liefern. GPT-5.6 speichert zusätzlich Cache-Read/Write-
   Tokens; `/api/chat/stats` liefert user-scoped 24h-/7d-/Gesamtwerte
8. Memory-Update: alle 10 Messages oder bei force (import memory.js → extractMemory)

**SSE-Protokoll** (`data: {json}\n\n`, HEILIGE Felder — nie umbenennen):
`{token}`, `{think}`, `{tool, status: running|done, query, ...}`, `{actionRequest: true, ...}`,
`{checkpoint: {name, args, result, key}}` (nur fertige web_search/firecrawl_scrape-Resultate),
`{error}`, `{done: true, context, tokens}`.

Weitere Endpunkte: `POST /:conversationId/cancel` (requestId-basiert, lib/chatCancellation.js),
`POST /models/list` (Z. ~2196 — Aggregat aus Ollama + konfigurierten Cloud-Providern;
einmal durch Refactoring gebrochen, vorsicht), `GET /stats` (user-scoped Token-Usage und
Prompt-Cache-Telemetrie), `POST /allowlist`
(Terminal-Freigaben), `GET|POST /memory` (Chat-bezogene Memory-Views).

### server/lib/chatCancellation.js (~120 Z.)
Registry aktiver Chat-Requests (userId+conversationId+requestId → AbortController).
Ein Verbindungsabbruch löst nur den konkreten SSE-Subscriber und beendet den
Luna-Lauf nicht mehr. Derselbe requestId kann sich innerhalb desselben
Serverprozesses wieder an den laufenden Stream anhängen; bereits abgeschlossene
IDs bleiben 30 Minuten als inhaltsgebundener Replay-Schutz erhalten. Nur der
explizite Cancel-Endpunkt setzt den AbortController. Die Modellantwort wird auch
ohne verbundenen Browser vollständig persistiert und beim Wiederöffnen aus der
Conversation geladen. In-Memory — pro Prozess; PM2-/Deploy-Handoffs für
Terminaloperationen bleiben zusätzlich über `terminalOperations.js` dauerhaft.

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
- **openai-responses.js** (~235 Z.): streamResponses, OpenAI Responses-API. GPT-5.6 nutzt
  einen gehashten stabilen `prompt_cache_key`, implizites Caching mit 30-Minuten-TTL und
  übernimmt `cached_tokens`/`cache_write_tokens` aus der API-Usage. Nur der erste
  System-Block wird zu `instructions`; spätere System-Hinweise bleiben als geordneter
  Developer-Input an ihrer Position.
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

`node:test` ohne separates Framework; `npm test` führt alle
`tests/*.test.mjs` aus. E3 Core Contracts und Zustandsmaschine werden
tabellengetrieben in `tests/e3SessionState.test.mjs` geprüft. Kein separates
Client-Testsetup.

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

### DeepSeek-Provider
DeepSeek V4 Flash läuft über `server/providers/openai-compatible.js` und den OpenAI-kompatiblen
Endpunkt. Modellpräfix `deepseek/`; `DEEPSEEK_API_KEY` aktiviert den Eintrag
`deepseek/deepseek-v4-flash` in der Modellliste. Thinking wird über `reasoningEffort`
gesteuert und Sampling-Parameter werden gemäß DeepSeek-Dokumentation weggelassen.

### Kimi-Provider
Kimi läuft über `server/providers/openai-compatible.js`, Modellpräfix `kimi/`; K3 nutzt `reasoning_effort`, Sampling-Parameter bleiben wegen fester Providerwerte weg. Bei Tool-Loops `reasoning_content` bewahren.


## E3 Schritt 14A.2 — Operational Pilot Harness

Der operator-only Harness liegt unter `server/e3/pilot/operationalPilot.js` mit dem CLI-Wrapper `scripts/e3-operational-pilot.mjs`. Er akzeptiert ausschließlich die drei festen Fälle `success`, `validation-reject` und `tamper-reject`, bindet das kanonische Image-Manifest und bleibt außerhalb von `server/index.js` und `server/worker.js`. Der CLI-Aufruf ist default-off und verlangt einmalig `E3_PILOT_HARNESS_ENABLED=true`; freie Pfade, Profile, Images oder Operationsdateien werden nicht akzeptiert.

Ein vollständiger Operatorlauf wird ausschließlich aus `/root/echolink` gestartet:

```bash
E3_PILOT_HARNESS_ENABLED=true npm run e3:pilot --
```

Der Lauf bewahrt nur `pilot-summary.json` und `pilot-attestation.json` unter einer privaten, eindeutig benannten `/tmp/echolink-e3-operational-pilot-*`-Wurzel auf. Repository-, `dist`- und E3-Docker-Inventar müssen vor und nach dem Lauf bytegleich beziehungsweise identisch sein. Produktive Apply-, Revert-, Deploy-, Push-, Commit-, PM2- und systemd-Aktionen sind ausgeschlossen.
