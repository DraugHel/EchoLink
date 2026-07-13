/**
 * Erkennt den MIME-Typ eines Base64-kodierten Bildes anhand
 * der üblichen Dateisignaturen.
 */
export function imgMediaType(b64) {
  if (b64.startsWith('/9j/')) return 'image/jpeg'
  if (b64.startsWith('iVBOR')) return 'image/png'
  if (b64.startsWith('R0lGOD')) return 'image/gif'
  if (b64.startsWith('UklGR')) return 'image/webp'
  return 'image/jpeg'
}
