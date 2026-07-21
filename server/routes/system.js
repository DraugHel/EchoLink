import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { exec } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import {
  getMcpRegistryStatus
} from '../lib/mcpRegistry.js'

const router = Router()

const DATABASE_BACKUP_ROOT =
  process.env.ECHOLINK_BACKUP_DIR ||
  '/root/echolink-backups/database'

const FULL_BACKUP_ROOT =
  process.env.ECHOLINK_EXPORT_DIR ||
  '/root/echolink-backups/export'

// 10s-Cache, damit Polling von mehreren Tabs den Server nicht nervt.
let cache = {
  t: 0,
  data: null
}

function run(command) {
  return new Promise(resolve => {
    exec(
      command,
      {
        timeout: 5000,
        maxBuffer: 5 * 1024 * 1024
      },
      (error, stdout) => {
        resolve(error ? '' : stdout)
      }
    )
  })
}

function round(value, digits = 0) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function bytesToMb(bytes) {
  return round(Number(bytes || 0) / 1024 / 1024, 1)
}

async function newestFile(root, matches, maxDepth = 3) {
  let newest = null

  async function walk(directory, depth) {
    if (depth > maxDepth) return

    let entries

    try {
      entries = await fs.readdir(
        directory,
        { withFileTypes: true }
      )
    } catch {
      return
    }

    await Promise.all(
      entries.map(async entry => {
        const fullPath = path.join(
          directory,
          entry.name
        )

        if (entry.isDirectory()) {
          await walk(fullPath, depth + 1)
          return
        }

        if (!entry.isFile() || !matches(entry.name)) {
          return
        }

        try {
          const stat = await fs.stat(fullPath)

          if (
            !newest ||
            stat.mtimeMs > newest.mtimeMs
          ) {
            newest = {
              name: entry.name,
              path: fullPath,
              mtimeMs: stat.mtimeMs,
              size: stat.size
            }
          }
        } catch {
          // Datei kann zwischen readdir und stat verschwinden.
        }
      })
    )
  }

  await walk(root, 0)

  if (!newest) {
    return {
      found: false,
      name: null,
      updatedAt: null,
      ageSeconds: null,
      sizeMb: null
    }
  }

  return {
    found: true,
    name: newest.name,
    updatedAt: new Date(
      newest.mtimeMs
    ).toISOString(),
    ageSeconds: Math.max(
      0,
      Math.floor(
        (Date.now() - newest.mtimeMs) / 1000
      )
    ),
    sizeMb: bytesToMb(newest.size)
  }
}

function parseDiskUsage(dfOutput) {
  const line = dfOutput
    .trim()
    .split(/\r?\n/)
    .at(-1)

  if (!line) {
    return {
      usedPercent: null,
      totalGb: null,
      freeGb: null
    }
  }

  const parts = line.trim().split(/\s+/)

  if (parts.length < 6) {
    return {
      usedPercent: null,
      totalGb: null,
      freeGb: null
    }
  }

  const totalKb = Number(parts[1])
  const freeKb = Number(parts[3])
  const usedPercent = Number(
    String(parts[4]).replace('%', '')
  )

  return {
    usedPercent:
      Number.isFinite(usedPercent)
        ? usedPercent
        : null,
    totalGb:
      Number.isFinite(totalKb)
        ? round(totalKb / 1024 / 1024, 1)
        : null,
    freeGb:
      Number.isFinite(freeKb)
        ? round(freeKb / 1024 / 1024, 1)
        : null
  }
}

router.get(
  '/status',
  requireAuth,
  async (req, res) => {
    if (
      Date.now() - cache.t < 10000 &&
      cache.data
    ) {
      return res.json(cache.data)
    }

    try {
      const [
        jlist,
        dfOutput,
        databaseBackup,
        fullBackup,
        mcpServers
      ] = await Promise.all([
        run('pm2 jlist'),
        run('df -Pk /'),
        newestFile(
          DATABASE_BACKUP_ROOT,
          name => name.endsWith('.db')
        ),
        newestFile(
          FULL_BACKUP_ROOT,
          name => name.endsWith('.tar.gz.enc'),
          1
        ),
        getMcpRegistryStatus()
      ])

      let apps = []

      try {
        apps = JSON.parse(jlist)
          .filter(
            process =>
              !process.name.startsWith('pm2-')
          )
          .map(process => {
            const startedAt = Number(
              process.pm2_env?.pm_uptime || 0
            )

            return {
              name: process.name,
              status:
                process.pm2_env?.status ||
                'unknown',
              restarts:
                process.pm2_env?.restart_time ??
                0,
              cpu:
                Number.isFinite(
                  Number(process.monit?.cpu)
                )
                  ? round(
                      Number(process.monit.cpu),
                      1
                    )
                  : null,
              memoryMb: bytesToMb(
                process.monit?.memory
              ),
              uptimeSeconds:
                startedAt > 0
                  ? Math.max(
                      0,
                      Math.floor(
                        (Date.now() - startedAt) /
                        1000
                      )
                    )
                  : null
            }
          })
      } catch {
        // PM2 nicht erreichbar -> leere Liste.
      }

      const totalMemory = os.totalmem()
      const freeMemory = os.freemem()
      const usedMemory =
        totalMemory - freeMemory

      const memoryUsedPercent =
        totalMemory > 0
          ? round(
              usedMemory / totalMemory * 100,
              1
            )
          : null

      const load = os.loadavg()
      const cpuCount = Math.max(
        1,
        os.cpus()?.length || 1
      )

      const cpuPercent = round(
        Math.min(
          100,
          Math.max(
            0,
            load[0] / cpuCount * 100
          )
        ),
        1
      )

      const disk = parseDiskUsage(dfOutput)

      const data = {
        apps,
        cpu: cpuPercent,
        load: round(load[0], 2),
        cores: cpuCount,
        memory: {
          usedPercent: memoryUsedPercent,
          usedMb: bytesToMb(usedMemory),
          totalMb: bytesToMb(totalMemory),
          freeMb: bytesToMb(freeMemory)
        },
        disk: disk.usedPercent,
        diskFreeGb: disk.freeGb,
        diskTotalGb: disk.totalGb,
        uptimeSeconds: Math.floor(
          os.uptime()
        ),
        backups: {
          database: databaseBackup,
          full: fullBackup
        },
        mcpServers
      }

      cache = {
        t: Date.now(),
        data
      }

      res.json(data)
    } catch {
      res.status(500).json({
        error: 'status failed'
      })
    }
  }
)

export default router
