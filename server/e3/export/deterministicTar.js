import { Buffer } from 'node:buffer'

const BLOCK_SIZE = 512
const TRAILER_SIZE = BLOCK_SIZE * 2
const PORTABLE_PATH = /^[A-Za-z0-9._/-]+$/

function tarError(message) {
  throw new Error(message)
}

function assertPath(name) {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    Buffer.byteLength(name, 'utf8') > 100 ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.includes('\\') ||
    name.includes('//') ||
    name.split('/').some(part => part === '.' || part === '..') ||
    !PORTABLE_PATH.test(name)
  ) {
    tarError('Tar entry path is not canonical and portable')
  }
  return name
}

function octal(value, width) {
  if (!Number.isSafeInteger(value) || value < 0) {
    tarError('Tar numeric field is invalid')
  }
  const digits = value.toString(8)
  if (digits.length > width - 1) {
    tarError('Tar numeric field exceeds its width')
  }
  return `${digits.padStart(width - 1, '0')}\0`
}

function writeAscii(header, offset, width, value) {
  const bytes = Buffer.from(value, 'ascii')
  if (bytes.length > width) tarError('Tar text field exceeds its width')
  bytes.copy(header, offset)
}

function headerFor(name, size) {
  const header = Buffer.alloc(BLOCK_SIZE)
  writeAscii(header, 0, 100, assertPath(name))
  writeAscii(header, 100, 8, octal(0o644, 8))
  writeAscii(header, 108, 8, octal(0, 8))
  writeAscii(header, 116, 8, octal(0, 8))
  writeAscii(header, 124, 12, octal(size, 12))
  writeAscii(header, 136, 12, octal(0, 12))
  header.fill(0x20, 148, 156)
  header[156] = 0x30
  writeAscii(header, 257, 6, 'ustar\0')
  writeAscii(header, 263, 2, '00')
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  writeAscii(
    header,
    148,
    8,
    `${checksum.toString(8).padStart(6, '0')}\0 `
  )
  return header
}

function paddingFor(size) {
  const remainder = size % BLOCK_SIZE
  return remainder === 0
    ? Buffer.alloc(0)
    : Buffer.alloc(BLOCK_SIZE - remainder)
}

export function buildDeterministicTar(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    tarError('Tar requires at least one entry')
  }
  const normalized = entries.map(entry => {
    if (!entry || typeof entry !== 'object') {
      tarError('Tar entry must be an object')
    }
    const name = assertPath(entry.name)
    const content = Buffer.isBuffer(entry.content)
      ? Buffer.from(entry.content)
      : Buffer.from(String(entry.content), 'utf8')
    return { name, content }
  }).sort((left, right) => left.name.localeCompare(right.name, 'en'))
  if (new Set(normalized.map(entry => entry.name)).size !== normalized.length) {
    tarError('Tar entry names must be unique')
  }
  const chunks = []
  for (const entry of normalized) {
    chunks.push(headerFor(entry.name, entry.content.length))
    chunks.push(entry.content)
    chunks.push(paddingFor(entry.content.length))
  }
  chunks.push(Buffer.alloc(TRAILER_SIZE))
  return Buffer.concat(chunks)
}

function parseOctal(header, offset, width) {
  const raw = header.subarray(offset, offset + width)
    .toString('ascii')
    .replace(/\0.*$/s, '')
    .trim()
  if (!/^[0-7]+$/.test(raw)) tarError('Tar numeric field is malformed')
  return Number.parseInt(raw, 8)
}

function headerChecksum(header) {
  const copy = Buffer.from(header)
  copy.fill(0x20, 148, 156)
  return copy.reduce((sum, byte) => sum + byte, 0)
}

function zeroBlock(block) {
  return block.every(byte => byte === 0)
}

export function parseDeterministicTar(buffer, {
  maxBytes = 128 * 1024 * 1024
} = {}) {
  if (!Buffer.isBuffer(buffer)) tarError('Tar input must be a Buffer')
  if (
    buffer.length < TRAILER_SIZE ||
    buffer.length > maxBytes ||
    buffer.length % BLOCK_SIZE !== 0
  ) {
    tarError('Tar size is invalid')
  }
  const entries = []
  const names = new Set()
  let offset = 0
  while (offset < buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK_SIZE)
    if (zeroBlock(header)) {
      const second = buffer.subarray(
        offset + BLOCK_SIZE,
        offset + TRAILER_SIZE
      )
      if (second.length !== BLOCK_SIZE || !zeroBlock(second)) {
        tarError('Tar trailer is incomplete')
      }
      if (!zeroBlock(buffer.subarray(offset + TRAILER_SIZE))) {
        tarError('Tar contains bytes after its trailer')
      }
      break
    }
    const name = assertPath(
      header.subarray(0, 100).toString('ascii').replace(/\0.*$/s, '')
    )
    if (names.has(name)) tarError('Tar contains duplicate entry names')
    names.add(name)
    if (
      parseOctal(header, 100, 8) !== 0o644 ||
      parseOctal(header, 108, 8) !== 0 ||
      parseOctal(header, 116, 8) !== 0 ||
      parseOctal(header, 136, 12) !== 0 ||
      header[156] !== 0x30 ||
      header.subarray(257, 263).toString('ascii') !== 'ustar\0' ||
      header.subarray(263, 265).toString('ascii') !== '00'
    ) {
      tarError('Tar header metadata is not deterministic V1')
    }
    const recordedChecksum = parseOctal(header, 148, 8)
    if (recordedChecksum !== headerChecksum(header)) {
      tarError('Tar header checksum is invalid')
    }
    const size = parseOctal(header, 124, 12)
    const contentStart = offset + BLOCK_SIZE
    const contentEnd = contentStart + size
    const nextOffset = contentEnd + paddingFor(size).length
    if (nextOffset > buffer.length - TRAILER_SIZE) {
      tarError('Tar entry exceeds package boundary')
    }
    const padding = buffer.subarray(contentEnd, nextOffset)
    if (!zeroBlock(padding)) tarError('Tar entry padding is non-zero')
    entries.push(Object.freeze({
      name,
      content: Buffer.from(buffer.subarray(contentStart, contentEnd))
    }))
    offset = nextOffset
  }
  if (offset >= buffer.length) tarError('Tar trailer is missing')
  const sorted = [...entries]
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
  if (entries.some((entry, index) => entry.name !== sorted[index])) {
    tarError('Tar entries are not canonically sorted')
  }
  return Object.freeze(entries)
}
