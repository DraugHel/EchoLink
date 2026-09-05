# Conversation Summary / Fortsetzung

## Bedienung

Im Aktionsmenü des aktuell geöffneten, nicht archivierten Chats steht **Zusammenfassen**. Der Dialog lädt nur einen vorhandenen Entwurf und einen Kosten-/Aufrufplan. Erst **Zusammenfassung erstellen** startet ein Modell.

Der Entwurf kann als Markdown bearbeitet, revisionsgeschützt gespeichert und kopiert werden. **In neuem Chat fortsetzen** speichert die aktuelle Fassung und erzeugt den Zielchat in derselben SQLite-Transaktion. Der Zielchat erhält genau eine normale User-Nachricht mit einem Herkunftsrahmen; es wird nichts automatisch gesendet und `createConvo()`/Memory-Update wird nicht verwendet.

Bei verändertem Quellchat ist ein gespeicherter Entwurf `stale`. Speichern und Fortsetzen werden dann abgewiesen, bis eine neue Zusammenfassung erfolgreich erzeugt wurde. Ein fehlgeschlagener, abgebrochener oder unvollständiger Modellaufruf ersetzt den vorhandenen Entwurf nicht.

## API

- `GET /api/conversations/:id/summary?model=...` – Entwurf, `stale`, aktiver Chat-Run und geschätzte maximale Anzahl Modellaufrufe.
- `POST /api/conversations/:id/summary/generate` – `{ model, requestId }`; tool-freie Generierung mit Snapshot-/Hash-Konfliktprüfung.
- `POST /api/conversations/:id/summary/cancel` – `{ requestId }`; bricht nur den eigenen aktiven Lauf für den Quellchat ab.
- `PATCH /api/conversations/:id/summary` – `{ content, expectedRevision }`.
- `POST /api/conversations/:id/summary/continue` – `{ content, expectedRevision, requestId }`; atomar und dauerhaft idempotent.

Fremde Ressourcen werden als 404 behandelt. Summary-Text ist auf 20.000 Zeichen begrenzt. Request-IDs verwenden dieselben Formatregeln wie Chat-Request-IDs.

## Modellaufrufe und lange Chats

Die Provider-Auswahl entspricht `chat.js`: `claude*`, `zai/`, `kimi/`, `deepseek/`, `llamacpp/`, `openai/`, sonst Ollama. Provider-Präfixe werden vor dem Aufruf entfernt. Es werden immer `tools: []` übergeben; ein trotzdem gelieferter Tool-Call ist ein Fehler.

Der vollständige bereinigte Snapshot enthält alle User-/Assistant-Nachrichten einschließlich gespeicherter `**Terminal:**`-Ausgaben, jedoch kein `think` und keine Attachment-Binärdaten; sichtbare `data:...;base64`-Medien werden vor dem Modellaufruf entfernt. Offensichtliche Secret-Formate werden ebenfalls vor dem Modellaufruf redigiert. Der Stale-Hash wird dagegen aus dem echten (nicht redigierten) Quelltext, Nachrichten-IDs/-Rollen, relevanten Attachment-Metadaten und den übernommenen Conversation-Einstellungen gebildet, damit auch reine Secret-Wertänderungen als Quelländerung erkannt werden.

Passt der Snapshot nicht in das konservative Modellbudget, wird chronologisch an Nachrichtengrenzen aufgeteilt; einzelne übergroße Nachrichten werden mit Teilnummern zerlegt. V1 erlaubt höchstens acht Teilaufrufe plus eine Synthese. Wenn schon die Vorabplanung darüber liegt oder die maximalen Teilergebnisse nicht in das Synthesebudget passen, startet kein kostenpflichtiger Aufruf.

Jeder abgeschlossene Provideraufruf wird mit `purpose = conversation_summary` erfasst. Fehlen Usage-Daten, wird ein explizit unbepreistes Ereignis gespeichert – nicht `$0` behauptet.

## Wesentliche Implementierungsabweichungen vom Plan

Die vorhandene Kontextbudget-Logik liegt in `server/routes/chat.js` lokal innerhalb des Request-Handlers und ist nicht sauber importierbar. Um den normalen Chatpfad nicht zu refaktorieren, spiegelt `conversationSummary.js` dieselben konservativen Defaults, Providerbudgets, Model-Hints und `CHAT_CONTEXT_*`-Overrides. Das ist bewusst getrennt und durch Tests für lange Verläufe abgesichert.

Für die Modell-Allowlist wird kein zweiter Modellkatalog aufgebaut: Das gespeicherte Quellmodell ist zulässig; ein davon abweichendes Summary-Modell muss serverseitig exakt im bereits vorhandenen `loadModelList()` aus `server/routes/chat.js` auftauchen. Dieser Loader wird dafür lediglich exportiert. Die UI bietet ebenfalls ausschließlich `/api/chat/models/list` plus das gespeicherte Quellmodell an. Provider-Routing und vorhandene Keys/URLs bleiben unverändert; es werden keine neuen Anbieter eingerichtet.

Die normale Systemkosten-Zusammenfassung behandelte bisher jedes Nicht-Memory-Ereignis als Chat. Der Patch ergänzt deshalb einen eigenen `summaryUsd`-Bucket, ohne bestehende Felder oder Auswertungen zu entfernen.
