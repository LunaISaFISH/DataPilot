/**
 * SHA-256 of raw bytes via WebCrypto, as lowercase hex. Used only on bytes the browser actually
 * holds (downloaded artifacts, the `/v1/ai/contract` test vector); JSON-derived hashes are never
 * recomputed client-side (spec §9.3).
 */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('WebCrypto is unavailable in this context (requires a secure context).');
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let hex = '';
  for (const byte of view) hex += byte.toString(16).padStart(2, '0');
  return hex;
}
