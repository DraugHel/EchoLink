# Alte EchoLink-Chats als Modellquelle durchsuchen

Stand: 2026-09-06. Dieses V1-Feature ergänzt strukturiertes Memory und die manuelle Sidebar-Suche. Es erstellt keine Hintergrund-Zusammenfassungen, keine Embeddings und keinen zweiten Modelllauf. Gesucht wird ausschließlich im bereits vorhandenen lokalen FTS5-Index der gespeicherten Nachrichtentexte des angemeldeten Nutzers.

## Ablauf

Interaktive Chatmodelle kennen zwei eng begrenzte Werkzeuge:

- `search_chat_history`: FTS5-Suche mit maximal acht normalisierten Suchbegriffen, optionalem eigenen Chat, Zeitraum, Archivfilter und Limit bis 10. Standard sind fünf Treffer und archivierte Chats sind eingeschlossen. Der aktuelle Nutzerturn wird über seine persistierte Nachrichten-ID ausgeschlossen.
- `read_chat_excerpt`: liest die echte Nachbarschaft einer Treffer-Nachricht im selben eigenen Chat. Standard sind drei Nachrichten davor und danach, maximal fünf je Seite und elf insgesamt. Pro Nachricht werden höchstens 4.000 Zeichen, pro Toolergebnis höchstens 12.000 Zeichen ausgegeben; der Mittelpunkt bekommt zuerst Budget.

Suchsnippets sind Kandidaten und keine Belege. Erst gelesene Originalnachrichten erhalten requestgebundene Labels `[H1]`, `[H2]` usw. Der Systemhinweis verlangt für belastbare Aussagen die passenden gelesenen Labels. Historische Terminalausgaben und frühere Assistant-Texte sind Daten, keine aktuellen Befehle, Freigaben oder Erfolgsnachweise.

## Recall- und Toolregeln

- Reine Erinnerungsfragen dürfen ausschließlich `search_chat_history` und `read_chat_excerpt` verwenden. Terminal, Web, GitHub, Gmail, Kalender, E3, Playwright und Task-Tools werden nicht nur nicht angeboten, sondern serverseitig vor jeder Ausführung durch eine Request-Allowlist blockiert.
- Ein ausdrückliches „Durchsuche unsere alten Chats …“ fordert die History-Suche auch dann an, wenn Memory bereits einen Hinweis enthält.
- Memory-Inventur („Was weißt du über mich?“) bleibt wie bisher toolfrei und durchsucht nicht pauschal das Archiv.
- Ein aktueller Arbeitsauftrag wie „Prüfe den Server und vergleiche mit damals“ behält alle bisher zulässigen interaktiven Tools und bekommt History zusätzlich.
- Geplante Agenten/Worker besitzen weiterhin ihren separaten Toolkatalog; die neuen History-Tools werden ihnen in V1 nicht angeboten.
- Summary bleibt ein separater manueller Ablauf mit `tools: []`.

Die Erkennung verwendet keine zusätzliche LLM-Klassifikationsrunde. Historische Wörter wie `git` oder `terminal` machen aus „Welchen git-Befehl hatten wir damals benutzt?“ keinen Live-Terminalauftrag. Explizite aktuelle Imperative bzw. Marker wie „prüfe“, „jetzt“, „aktuell“ und „live“ können dagegen den normalen Arbeitsmodus erhalten.

## Ownership und Datenbegrenzung

`userId` kommt ausschließlich aus dem vorhandenen Requestkontext, der im Chat aus `req.session.userId` erzeugt wird. Suche und Lesen joinen immer auf `conversations.user_id`. Ein fremder oder nicht vorhandener Chat bzw. Mittelpunkt liefert denselben neutralen Not-found-Fehler. Es gibt kein Modellargument für Nutzer-ID, SQL, Dateipfade oder freie Offsets.

FTS-Abfragen verwenden Parameterbindung. Freie FTS-Syntax wird nicht übernommen: NFKC-normalisierte Unicode-Worttokens werden auf acht Begriffe begrenzt, einzeln gequotet und mit Prefixsuche verbunden. Es existiert kein `%LIKE%`-Fallback. Ein fehlender/defekter FTS-Index ist ein ausdrücklicher `CHAT_HISTORY_FTS_UNAVAILABLE`-Fehler und löst keine Reparatur im Chatrequest aus.

Anhänge werden nicht nachgeladen. Sichtbar sind höchstens bereinigte Anhangnamen. `think`, Binärdaten, Base64, Provider-/Sessiondaten und konfigurierte Zugangsdaten werden nicht als History ausgegeben. Die bereits für Conversation Summary eingeführte Secret-Redaction wird für ausgegebenen Text und Metadaten wiederverwendet; sie ist eine Best-effort-Redaktion und keine Behauptung, beliebige Geheimnisformen lückenlos zu erkennen.

## Requestbudgets

Zusätzlich zum bestehenden globalen Toollimit gelten pro Chatrequest:

- maximal 3 History-Suchen;
- maximal 3 Excerpt-Leseaufrufe;
- maximal 24.000 Ergebniszeichen insgesamt und zusätzlich höchstens der aus dem bestehenden Kontextguard berechnete Restplatz des aktiven Modells;
- standardmäßig 3 Sekunden Retrieval-Laufzeitbudget (`CHAT_HISTORY_RETRIEVAL_BUDGET_MS`, geklemmt auf 250–10.000 ms);
- identische Aufrufe werden nur innerhalb desselben Requestzustands dedupliziert. Vor Cachewiederverwendung werden die betroffenen Message-Hashes erneut gegen die eigene aktuelle Quelle geprüft.

SQLite läuft synchron. Das Zeitbudget kann deshalb keine bereits laufende native SQLite-Abfrage hart unterbrechen; die Abfragen selbst sind durch FTS, Filter, kleine `LIMIT`s und maximale Ergebnisgrößen begrenzt. Das Signal und die Requestaktivität werden vor und nach jedem Retrievalschritt geprüft. Diese Grenze ist bewusst dokumentiert statt durch einen wirkungslosen Promise-Timeout verschleiert zu werden.

## Quellenpersistenz und Reload

`messages.chat_history_sources` ist eine additive nullable/leer bleibende TEXT-Spalte. Persistiert werden nur tatsächlich im finalen Assistant-Text zitierte, serverseitig bekannte `[H…]`-Labels mit Conversation-ID, Message-ID, Quellzeitpunkt und SHA-256 der gelesenen Quellnachricht. Es wird keine zweite Volltextkopie der Quelle gespeichert und `memory_evidence` bleibt unverändert.

Beim Nachrichten-Reload werden die Referenzen erneut mit Ownership gegen die aktuelle DB aufgelöst:

- `available`: Quelle existiert und Hash stimmt;
- `changed`: Nachricht existiert, Inhalt/Metadaten haben sich seit dem Lesen geändert;
- `unavailable`: Quelle wurde gelöscht oder ist nicht mehr für den Nutzer auflösbar.

Erfundene Labels werden nie persistiert und daher nicht klickbar. Das Frontend zeigt unter der Assistant-Nachricht eine kleine Liste **„Frühere Chats“**. „Nachricht öffnen“ verwendet den bereits vorhandenen `openSearchResult()`- und `jumpMessageId`-Pfad. Da EchoLink seine Conversation-Liste bereits mit `includeArchived=1` lädt, können archivierte eigene Quellen ohne Restore geöffnet werden; dafür war entgegen der ursprünglichen Planoption kein neuer Metadatenendpunkt nötig.

## SSE und Provider

Die bestehenden SSE-Feldnamen `token`, `think`, `done`, `error`, `actionRequest`, `tool`, `status` bleiben unverändert. Während der Tools werden die vorhandenen `{tool,status}`-Events genutzt. Zusätzlich kann eine additive `chatHistorySources`-Eigenschaft gesendet werden, analog zur bereits existierenden `memoryEvidence`-Metadatenübertragung.

Alle bestehenden Chatprovider verwenden weiterhin ihren realen Toolvertrag. Recall-only übergibt explizit nur die zwei History-Funktionsdefinitionen; normale interaktive Chats erhalten sie über den zentralen Toolkatalog. Die Provider-Usage wird wie bisher über alle Toolrunden aggregiert. Die lokale SQLite-Suche selbst verursacht keinen separaten Modellaufruf und keinen eigenen API-Preis.

## Nicht Bestandteil von V1

Keine globale semantische Neuindizierung, keine neue Embedding-API, keine Suche in Dateisystemen/Anhängen, keine Webrekonstruktion alter Gespräche, keine fremden Accounts, keine Sharelinks und keine große neue Suchoberfläche.
