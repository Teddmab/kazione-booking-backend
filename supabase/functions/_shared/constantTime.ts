/**
 * Constant-time string comparison to prevent timing attacks on secret/token
 * comparisons (booking lookups by email, signed-token signatures, etc.).
 * Returns true if the two strings are equal.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = new TextEncoder().encode(a);
  const bBuf = new TextEncoder().encode(b);

  if (aBuf.length !== bBuf.length) {
    // Still do a full comparison to avoid length-based timing leaks.
    let result = 1;
    for (let i = 0; i < aBuf.length; i++) {
      result |= aBuf[i] ^ (bBuf[i % bBuf.length] ?? 0);
    }
    return false;
  }

  let result = 0;
  for (let i = 0; i < aBuf.length; i++) {
    result |= aBuf[i] ^ bBuf[i];
  }
  return result === 0;
}
