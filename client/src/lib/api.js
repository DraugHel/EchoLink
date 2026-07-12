async function apiError(response) {
  const contentType = response.headers.get('content-type') || ''
  let message = ''

  try {
    if (contentType.includes('application/json')) {
      const data = await response.json()
      message = data?.error || data?.message || ''
    } else {
      message = (await response.text()).trim()
    }
  } catch {}

  if (message.startsWith('<!DOCTYPE') || message.startsWith('<html')) {
    message = ''
  }

  const error = new Error(
    message || response.statusText || `HTTP ${response.status}`
  )
  error.status = response.status
  return error
}

async function readJson(response) {
  if (!response.ok) throw await apiError(response)

  if (response.status === 204) return null

  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) {
    throw new Error('Server hat keine JSON-Antwort geliefert')
  }

  return response.json()
}

const api = {
  async get(path) {
    const r = await fetch(path)
    return readJson(r)
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    return readJson(r)
  },
  async patch(path, body) {
    const r = await fetch(path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    return readJson(r)
  },
  async put(path, body) {
    const r = await fetch(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    return readJson(r)
  },
  async delete(path) {
    const r = await fetch(path, { method: 'DELETE' })
    return readJson(r)
  }
}

export default api
