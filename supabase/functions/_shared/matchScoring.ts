// Shared scoring math for fuzzy record-matching — used by receipt-scan's
// OCR→record matching (match.ts) and bank-statements' reversed
// transaction→record suggestion (suggestMatches.ts), so the two scorers
// can't drift apart into subtly different formulas.

/** 1.0 at a perfect match, decreasing linearly with relative distance.
 *  Callers pre-filter to an amount window (typically ±5%), so this only
 *  needs to express "how good within that window," not clamp/reject
 *  outside it. */
export function amountScore(candidateAmount: number, targetAmount: number): number {
  if (targetAmount === 0) return candidateAmount === 0 ? 1 : 0;
  return 1 - Math.abs(candidateAmount - targetAmount) / Math.abs(targetAmount);
}

/** 1.0 at zero days apart, 0 at `windowDays` or more apart. */
export function dateScore(candidateMs: number, targetMs: number, windowDays: number): number {
  const daysDiff = Math.abs(candidateMs - targetMs) / 86_400_000;
  return Math.max(0, 1 - daysDiff / windowDays);
}

/** 1 if `needle` appears in `haystack` (case-insensitive), else 0. */
export function merchantSubstringScore(haystack: string, needle: string | null): number {
  if (!needle) return 0;
  return haystack.toLowerCase().includes(needle.toLowerCase()) ? 1 : 0;
}
