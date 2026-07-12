import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { exec } from 'child_process'
import os from 'os'

const router = Router()

// 10s-Cache, damit Polling von mehreren Tabs den Server nicht nervt
let cache = { t: 0, data: null }

function run(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 5000 }, (err, stdout) => resolve(err ? '' : stdout))
  })
}

router.get('/status', requireAuth, async (req, res) => {
  if (Date.now() - cache.t < 10000 && cache.data) return res.json(cache.data)
  try {
    const [jlist, dfOut] = await Promise.all([
      run('pm2 jlist'),
      run('df -P / | tail -1')
    ])

    let apps = []
    try {
      apps = JSON.parse(jlist)
        .filter(p => !p.name.startsWith('pm2-'))
        .map(p => ({
          name: p.name,
          status: p.pm2_env?.status || 'unknown',
          restarts: p.pm2_env?.restart_time ?? 0
        }))
    } catch { /* pm2 nicht erreichbar -> leere Liste */ }

    const diskMatch = dfOut.match(/(\d+)%/)
    const data = {
      apps,
      disk: diskMatch ? parseInt(diskMatch[1], 10) : null,
      load: Math.round(os.loadavg()[0] * 100) / 100
    }
    cache = { t: Date.now(), data }
    res.json(data)
  } catch {
    res.status(500).json({ error: 'status failed' })
  }
})

export default router
