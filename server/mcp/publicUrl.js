import dns from 'node:dns/promises'
import net from 'node:net'

function privateIpv4(address) {
  const parts = address
    .split('.')
    .map(Number)

  if (
    parts.length !== 4 ||
    parts.some(part =>
      !Number.isInteger(part) ||
      part < 0 ||
      part > 255
    )
  ) {
    return true
  }

  const [a, b] = parts

  return Boolean(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

function privateIpv6(address) {
  const normalized = address
    .toLowerCase()
    .split('%')[0]

  if (
    normalized === '::' ||
    normalized === '::1'
  ) {
    return true
  }

  if (
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    return true
  }

  const mapped = normalized.match(
    /^::ffff:(\d+\.\d+\.\d+\.\d+)$/
  )

  return mapped
    ? privateIpv4(mapped[1])
    : false
}

export function isPrivateNetworkAddress(address) {
  const family = net.isIP(address)

  if (family === 4) {
    return privateIpv4(address)
  }

  if (family === 6) {
    return privateIpv6(address)
  }

  return true
}

export async function assertPublicHttpUrl(
  value,
  lookup = dns.lookup
) {
  let url

  try {
    url = new URL(String(value || '').trim())
  } catch {
    throw new Error('URL ist ungültig')
  }

  if (
    url.protocol !== 'http:' &&
    url.protocol !== 'https:'
  ) {
    throw new Error('Nur HTTP- und HTTPS-URLs sind erlaubt')
  }

  if (url.username || url.password) {
    throw new Error('URLs mit Zugangsdaten sind nicht erlaubt')
  }

  const hostname = url.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()

  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error('Lokale Zieladressen sind nicht erlaubt')
  }

  if (
    net.isIP(hostname) &&
    isPrivateNetworkAddress(hostname)
  ) {
    throw new Error('Private Zieladressen sind nicht erlaubt')
  }

  const resolved = await lookup(
    hostname,
    {
      all: true,
      verbatim: true
    }
  )

  if (
    !Array.isArray(resolved) ||
    resolved.length === 0
  ) {
    throw new Error('Zieladresse konnte nicht aufgelöst werden')
  }

  if (
    resolved.some(entry =>
      isPrivateNetworkAddress(entry.address)
    )
  ) {
    throw new Error('Ziel löst auf ein privates Netzwerk auf')
  }

  url.hash = ''
  return url.href
}
