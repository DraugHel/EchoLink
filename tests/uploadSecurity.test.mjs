import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { once } from 'node:events'
import test from 'node:test'
import express from 'express'

import uploadRoutes, {
  UPLOAD_DIR
} from '../server/routes/uploads.js'
import {
  isSafeStoredUploadFilename,
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_IMAGE_PIXELS,
  uploadAccepted,
  uploadResponseHeaders
} from '../server/lib/uploadPolicy.js'

function testApp(userId) {
  const app = express()

  app.use((req, res, next) => {
    req.session = { userId }
    next()
  })

  app.use('/api/uploads', uploadRoutes)

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error)

    res.status(
      error?.statusCode || 500
    ).json({
      error: error?.expose
        ? error.message
        : 'Internal server error'
    })
  })

  return app
}

async function withServer(userId, callback) {
  const directory = path.join(
    UPLOAD_DIR,
    String(userId)
  )
  const server = testApp(userId).listen(
    0,
    '127.0.0.1'
  )

  await once(server, 'listening')

  try {
    const address = server.address()
    await callback(
      `http://127.0.0.1:${address.port}`,
      directory
    )
  } finally {
    server.close()
    await once(server, 'close')
    await fs.rm(directory, {
      recursive: true,
      force: true
    })
  }
}

test(
  'aktive Uploads werden nur als gesandboxter Download ausgeliefert',
  async () => {
    await withServer(
      `upload-security-${process.pid}-html`,
      async baseUrl => {
        const form = new FormData()

        form.append(
          'files',
          new Blob(
            ['<script>document.body.textContent="unsafe"</script>'],
            { type: 'text/html' }
          ),
          'proof.html'
        )

        const uploadResponse = await fetch(
          `${baseUrl}/api/uploads`,
          {
            method: 'POST',
            body: form
          }
        )

        assert.equal(uploadResponse.status, 200)

        const uploaded = await uploadResponse.json()
        const filename = uploaded.files[0].filename

        const downloadResponse = await fetch(
          `${baseUrl}/api/uploads/${filename}`
        )

        assert.equal(downloadResponse.status, 200)
        assert.equal(
          downloadResponse.headers.get(
            'content-disposition'
          ),
          'attachment'
        )
        assert.equal(
          downloadResponse.headers.get(
            'content-type'
          ),
          'application/octet-stream'
        )
        assert.equal(
          downloadResponse.headers.get(
            'x-content-type-options'
          ),
          'nosniff'
        )
        assert.match(
          downloadResponse.headers.get(
            'content-security-policy'
          ) || '',
          /sandbox/
        )
        assert.match(
          downloadResponse.headers.get(
            'cache-control'
          ) || '',
          /no-store/
        )
      }
    )
  }
)

test(
  'ungültige Bilddaten werden verworfen und nicht liegen gelassen',
  async () => {
    await withServer(
      `upload-security-${process.pid}-image`,
      async (baseUrl, directory) => {
        const form = new FormData()

        form.append(
          'files',
          new Blob(
            ['definitely not a PNG'],
            { type: 'image/png' }
          ),
          'broken.png'
        )

        const response = await fetch(
          `${baseUrl}/api/uploads`,
          {
            method: 'POST',
            body: form
          }
        )

        assert.equal(response.status, 400)

        const remaining = await fs.readdir(
          directory
        ).catch(() => [])

        assert.deepEqual(remaining, [])
      }
    )
  }
)

test(
  'Upload-Policy begrenzt Größe, Anzahl, MIME-Typen und Pfade',
  () => {
    assert.equal(MAX_UPLOAD_FILES, 5)
    assert.equal(
      MAX_UPLOAD_FILE_BYTES,
      25 * 1024 * 1024
    )
    assert.equal(
      MAX_UPLOAD_IMAGE_PIXELS,
      40 * 1000 * 1000
    )

    assert.equal(
      uploadAccepted('photo.jpg', 'image/jpeg'),
      true
    )
    assert.equal(
      uploadAccepted('photo.jpg', 'text/html'),
      false
    )
    assert.equal(
      uploadAccepted('notes.html', 'text/html'),
      true
    )
    assert.equal(
      uploadAccepted('payload.svg', 'image/svg+xml'),
      false
    )
    assert.equal(
      uploadAccepted('../notes.txt', 'text/plain'),
      false
    )
    assert.equal(
      uploadAccepted('..\\notes.txt', 'text/plain'),
      false
    )

    assert.equal(
      isSafeStoredUploadFilename(
        '1720000000000_abcdef123456.txt'
      ),
      true
    )
    assert.equal(
      isSafeStoredUploadFilename('../secret.txt'),
      false
    )
    assert.equal(
      isSafeStoredUploadFilename('nested/file.txt'),
      false
    )

    const imageHeaders =
      uploadResponseHeaders('safe.jpg')

    assert.equal(
      imageHeaders['Content-Disposition'],
      'inline'
    )
    assert.equal(
      imageHeaders['Content-Type'],
      'image/jpeg'
    )
  }
)

test(
  'Multer ist auf die bereinigte Version 2.2.0 gepinnt',
  async () => {
    const packageJson = JSON.parse(
      await fs.readFile(
        new URL('../package.json', import.meta.url),
        'utf8'
      )
    )
    const lock = JSON.parse(
      await fs.readFile(
        new URL(
          '../package-lock.json',
          import.meta.url
        ),
        'utf8'
      )
    )

    assert.equal(
      packageJson.dependencies.multer,
      '2.2.0'
    )
    assert.equal(
      lock.packages['node_modules/multer']
        .version,
      '2.2.0'
    )
  }
)
