// Laedt .env aus dem Projekt-Root in process.env, OHNE bereits gesetzte
// Variablen (z.B. aus PM2 ecosystem) zu ueberschreiben.
// Muss als ERSTER Import in index.js stehen, da Route-Module ihre
// process.env-Werte schon beim Import lesen (ESM-Imports werden gehoistet).
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parseEnv } from 'node:util'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const envPath = path.join(__dirname, '..', '.env')

try {
  const parsed = parseEnv(fs.readFileSync(envPath, 'utf-8'))
  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in process.env)) process.env[key] = value
  }
} catch {
  // Keine .env vorhanden — ok, dann muss alles aus der Umgebung kommen
}
