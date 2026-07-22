# Playwright MCP in EchoLink

EchoLink verwendet den offiziellen Microsoft Playwright MCP Server als
gepinntes Containerimage:

```text
mcr.microsoft.com/playwright/mcp:v0.0.78
```

Die Upstream-Dokumentation weist darauf hin, dass Playwright MCP selbst keine
Sicherheitsgrenze ist. EchoLink ergänzt deshalb eine eigene feste Tool-Allowlist,
eine exakte Origin-Allowlist und einen gehärteten, flüchtigen Docker-Container.

## Aktivieren

Voraussetzung ist ein laufender Docker-Dienst. In `.env`:

```dotenv
MCP_PLAYWRIGHT_MODE=active
MCP_PLAYWRIGHT_URL=http://127.0.0.1:3012/mcp
MCP_PLAYWRIGHT_ALLOWED_ORIGINS=http://127.0.0.1:3000
MCP_PLAYWRIGHT_REQUEST_TIMEOUT_MS=20000
MCP_PLAYWRIGHT_TOOL_TIMEOUT_MS=20000
MCP_PLAYWRIGHT_FALLBACK_COOLDOWN_MS=15000
```

Mehrere exakte Origins werden mit Semikolon getrennt. Wildcards, Pfade,
Credentials und `file://` sind ungültig:

```dotenv
MCP_PLAYWRIGHT_ALLOWED_ORIGINS=http://127.0.0.1:3000;https://example.org
```

Danach wie üblich deployen:

```bash
cd /root/echolink
npm run deploy
```

Das Deployment lädt das gepinnte Image nur, wenn es lokal noch fehlt, startet
`echolink-mcp-playwright` über PM2 und führt den Browser-Smoke-Test aus.

## Freigegebene Tools

- `browser_navigate`
- `browser_snapshot`
- `browser_find`
- `browser_click`
- `browser_type`
- `browser_console_messages`
- `browser_network_requests`
- `browser_tabs`
- `browser_close`

Klicks brauchen eine Element-Ref aus dem letzten Snapshot. Text wird nie mit
`submit=true` weitergegeben. Datei- und Ergebnisparameter werden entfernt.

## Immer blockiert

- `browser_run_code` und `browser_run_code_unsafe`
- `browser_evaluate`
- Datei-Uploads, File-Drops und Downloads
- Screenshots und PDF-Dateien
- Clipboard-Berechtigungen
- beliebige Selektoren und freie JavaScript-Ausführung
- Navigation und Subrequests außerhalb der Origin-Allowlist
- neue Tabs mit einer frei gewählten URL
- offensichtlich destruktive Klicks und sensible Eingabefelder

Der Container ist read-only, besitzt keine Host-Dateisystemfreigabe außer der
read-only Origin-Guard-Datei, verwirft sein Profil beim Beenden und bindet den
MCP-Port ausschließlich an `127.0.0.1`.

## Sitzungsmodell

Jeder Chat-Auftrag, geplante Agentenlauf und Smoke-Test erhält eine eigene
flüchtige MCP-Sitzung mit eigenem isolierten Browserkontext. Alle Browser-Tools
eines Laufs werden seriell über dieselbe Verbindung ausgeführt. Dadurch sehen
Snapshot, Console und Netzwerk dieselbe zuvor geöffnete Seite, ohne dass
parallele Läufe Tabs oder Zustand miteinander teilen.

EchoLink schließt die Sitzung am Laufende auch dann, wenn das Modell
`browser_close` nicht selbst aufruft. Bei Nutzerabbruch oder Zeitüberschreitung
wird die gehaltene MCP-Verbindung ebenfalls freigegeben. Das beschreibbare
Browser-Home liegt ausschließlich in einem flüchtigen, auf UID/GID 1000
begrenzten tmpfs; ein persönliches oder dauerhaftes Browserprofil wird nicht
verwendet.

## Prüfen

```bash
cd /root/echolink
npm run mcp:playwright:smoke
pm2 describe echolink-mcp-playwright
```

Der Systemstatus zeigt Registry-Erreichbarkeit, Discovery, Tool-Allowlist,
Latenz, Fehlerzähler und Circuit Breaker automatisch an.

Der Smoke-Test akzeptiert nur einen Snapshot der konfigurierten EchoLink-URL
mit Seitentitel `EchoLink`; `about:blank` wird ausdrücklich als Fehler
behandelt.

Upstream: <https://github.com/microsoft/playwright-mcp>
