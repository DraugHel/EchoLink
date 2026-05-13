const api = {
  async get(path) {
    const r = await fetch(path)
    if (!r.ok) throw new Error((await r.json()).error || r.statusText)
    return r.json()
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!r.ok) throw new Error((await r.json()).error || r.statusText)
    return r.json()
  },
  async patch(path, body) {
    const r = await fetch(path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!r.ok) throw new Error((await r.json()).error || r.statusText)
    return r.json()
  },
  async delete(path) {
    const r = await fetch(path, { method: 'DELETE' })
    if (!r.ok) throw new Error((await r.json()).error || r.statusText)
    return r.json()
  }
}

export default api
