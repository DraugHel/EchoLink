const guardedContexts = new WeakSet()
const guardedPages = new WeakSet()

const dangerousActionPattern = [
  'accept',
  'allow',
  'authorize',
  'bestätig',
  'bezahl',
  'buy',
  'checkout',
  'confirm',
  'delete',
  'deploy',
  'entfern',
  'erase',
  'freigeb',
  'herunterlad',
  'hochlad',
  'kauf',
  'lösch',
  'merge',
  'order',
  'pay',
  'publish',
  'purchase',
  'remove',
  'restart',
  'save',
  'send',
  'senden',
  'shutdown',
  'sign[ -]?out',
  'speicher',
  'stop',
  'submit',
  'trigger',
  'upload',
  'download',
  'write',
  'ausführ'
].join('|')

function allowedOrigins() {
  const raw = String(
    process.env.MCP_PLAYWRIGHT_ALLOWED_ORIGINS ||
      'http://127.0.0.1:3000'
  )

  const origins = raw
    .split(';')
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => {
      const url = new URL(value)

      if (
        (url.protocol !== 'http:' &&
          url.protocol !== 'https:') ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      ) {
        throw new Error(
          `Invalid Playwright origin: ${value}`
        )
      }

      return url.origin
    })

  if (origins.length === 0) {
    throw new Error(
      'At least one Playwright origin is required'
    )
  }

  return new Set(origins)
}

function protectPage(page, origins) {
  if (guardedPages.has(page)) return
  guardedPages.add(page)

  page.on('download', download => {
    void download.cancel().catch(() => {})
  })

  page.on('filechooser', chooser => {
    void chooser.setFiles([]).catch(() => {})
  })

  page.on('dialog', dialog => {
    void dialog.dismiss().catch(() => {})
  })

  page.on('framenavigated', frame => {
    if (frame !== page.mainFrame()) return

    const currentUrl = frame.url()

    if (currentUrl === 'about:blank') return

    try {
      const url = new URL(currentUrl)

      if (
        (url.protocol === 'http:' ||
          url.protocol === 'https:') &&
        origins.has(url.origin)
      ) {
        return
      }
    } catch {}

    console.warn(JSON.stringify({
      level: 'warn',
      event: 'playwright_navigation_blocked'
    }))

    void page.close({
      runBeforeUnload: false
    }).catch(() => {})
  })
}

export default async ({ page }) => {
  const context = page.context()
  const origins = allowedOrigins()
  protectPage(page, origins)

  if (guardedContexts.has(context)) return
  guardedContexts.add(context)

  await context.clearPermissions()

  await context.addInitScript(
    ({ allowed, dangerPattern }) => {
      const allowedOrigins = new Set(allowed)
      const dangerous = new RegExp(
        dangerPattern,
        'iu'
      )

      const block = event => {
        event.preventDefault()
        event.stopImmediatePropagation()
      }

      const urlAllowed = value => {
        try {
          const url = new URL(value, location.href)
          return (
            (url.protocol === 'http:' ||
              url.protocol === 'https:') &&
            allowedOrigins.has(url.origin)
          )
        } catch {
          return false
        }
      }

      document.addEventListener('submit', block, true)

      for (const eventName of [
        'copy',
        'cut',
        'paste',
        'drop'
      ]) {
        document.addEventListener(
          eventName,
          block,
          true
        )
      }

      document.addEventListener('click', event => {
        const target = event.target instanceof Element
          ? event.target
          : null

        if (!target) return

        const submitControl = target.closest(
          'button:not([type]),button[type="submit"],input[type="submit"],input[type="image"]'
        )

        if (submitControl) {
          block(event)
          return
        }

        const interactive = target.closest(
          'button,a,[role="button"],input'
        )
        const label = [
          interactive?.getAttribute('aria-label'),
          interactive?.getAttribute('title'),
          interactive?.getAttribute('value'),
          interactive?.textContent
        ].filter(Boolean).join(' ')

        if (label && dangerous.test(label)) {
          block(event)
          return
        }

        const anchor = target.closest('a[href]')

        if (
          anchor &&
          (anchor.hasAttribute('download') ||
            !urlAllowed(anchor.href))
        ) {
          block(event)
        }
      }, true)

      const disabledClipboard = Object.freeze({
        read: () => Promise.reject(
          new Error('Clipboard disabled')
        ),
        readText: () => Promise.reject(
          new Error('Clipboard disabled')
        ),
        write: () => Promise.reject(
          new Error('Clipboard disabled')
        ),
        writeText: () => Promise.reject(
          new Error('Clipboard disabled')
        )
      })

      try {
        Object.defineProperty(
          Navigator.prototype,
          'clipboard',
          {
            configurable: false,
            get: () => disabledClipboard
          }
        )
      } catch {}

      try {
        const open = window.open.bind(window)

        Object.defineProperty(window, 'open', {
          configurable: false,
          value: (url, ...args) => {
            if (!url || !urlAllowed(url)) return null
            return open(url, ...args)
          }
        })
      } catch {}
    },
    {
      allowed: [...origins],
      dangerPattern: dangerousActionPattern
    }
  )

  await context.route('**/*', async route => {
    let url

    try {
      url = new URL(route.request().url())
    } catch {
      await route.abort('blockedbyclient')
      return
    }

    const allowed =
      (url.protocol === 'http:' ||
        url.protocol === 'https:') &&
      !url.username &&
      !url.password &&
      origins.has(url.origin)

    if (!allowed) {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'playwright_origin_blocked',
        origin: url.origin
      }))
      await route.abort('blockedbyclient')
      return
    }

    await route.continue()
  })

  if (typeof context.routeWebSocket === 'function') {
    await context.routeWebSocket('**/*', webSocket => {
      webSocket.close()
    })
  }

  context.on('page', newPage => {
    protectPage(newPage, origins)
  })
}
