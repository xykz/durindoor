/**
 * Parse a per-request account token budget from a client header value.
 *
 * Used by `x-connection-token-budget`: the caller caps how many tokens each
 * account may consume in the trailing 24 hours before the router stops
 * selecting it. Providers throttle on demand (e.g. CodeBuddy CN at ~2e8
 * tokens/24h), so this is supplied per request rather than persisted.
 *
 * Accepted forms:
 * - `180000000` / `1.8b` / `180m` / `180000k` — bare numbers or k/m/b suffixes
 * - blank, non-positive, or malformed → `null` (no budget)
 *
 * @param {unknown} value - Raw header value.
 * @returns {number|null} Non-negative integer token budget, or null for none.
 */
export function parseTokenBudget(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (!text) return null;
  const match = text.match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const scale = match[2] === "k" ? 1e3 : match[2] === "m" ? 1e6 : match[2] === "b" ? 1e9 : 1;
  const budget = Math.floor(amount * scale);
  return Number.isSafeInteger(budget) && budget > 0 ? budget : null;
}
