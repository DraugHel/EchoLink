# EchoLink — Deployment auf Hetzner

## Voraussetzungen
- Node.js 18+ (`node -v`)
- Ollama läuft auf `localhost:11434`
- Port 3000 in der Hetzner Firewall offen (oder was du willst)

---

## Setup

```bash
# 1. Entpacken
unzip echolink.zip
cd echolink

# 2. Server-Dependencies installieren
npm install

# 3. Client bauen
cd client
npm install
npm run build
cd ..

# 4. Ersten User anlegen (Server muss einmal gestartet worden sein für DB-Init)
node server/index.js &   # kurz starten
# Warte 2 Sekunden, dann Ctrl+C
node scripts/adduser.js markus deinpasswort

# 5. Mit PM2 dauerhaft starten
npm install -g pm2
pm2 start server/index.js --name echolink
pm2 save
pm2 startup
```

---

## Umgebungsvariablen (optional)

Erstelle eine `.env`-Datei oder setze diese beim Start:

```bash
PORT=3000                          # Standard: 3000
SESSION_SECRET=langes-zufaelliges-geheimnis  # UNBEDINGT ändern!
OLLAMA_URL=http://localhost:11434   # Standard
```

Mit PM2 und env:
```bash
pm2 start server/index.js --name echolink --env production
```

Oder in `ecosystem.config.js`:
```js
module.exports = {
  apps: [{
    name: 'echolink',
    script: 'server/index.js',
    env: {
      PORT: 3000,
      SESSION_SECRET: 'dein-langes-geheimnis-hier',
      OLLAMA_URL: 'http://localhost:11434'
    }
  }]
}
```

---

## User-Management

```bash
# User hinzufügen
node scripts/adduser.js <username> <password>

# Beispiel
node scripts/adduser.js draug supergeheimespasswort
```

---

## Zugriff

```
http://<deine-server-ip>:3000
```

---

## Updates

```bash
# Code ersetzen, dann:
cd client && npm run build && cd ..
pm2 restart echolink
```
