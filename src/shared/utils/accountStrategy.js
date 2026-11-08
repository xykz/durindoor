/**
 * Parse a per-request account-selection strategy from a client header value.
 *
 * Used by `x-account-strategy`, which overrides the persisted
 * `fallbackStrategy` (global setting or `providerStrategies[provider]`) for one
 * request without touching the dashboard. Only values that the selector knows
 * how to honor are accepted; everything else keeps the stored strategy.
 *
 * Accepted values (case-insensitive, surrounding whitespace ignored):
 * - `bonus-first` — round-robin that prefers the account holding the
 *   earliest-expiring one-shot credit pool (CodeBuddy CN bonus packs).
 * - blank, missing, or unknown → `null` (keep the configured strategy)
 *
 * @see docs/features/smart-routing.md
 * @module src/shared/utils/accountStrategy
 */

import { isString } from "./typeChecks.js";

/** Strategies a client may select per request. */
export const ACCOUNT_STRATEGIES = Object.freeze(["bonus-first"]);

/**
 * Every strategy value that advances accounts like round-robin (as opposed to
 * fill-first / priority order). Selection code branches on this set instead of
 * the single `"round-robin"` literal.
 */
export const ROUND_ROBIN_STRATEGIES = Object.freeze(["round-robin", "bonus-first"]);

/**
 * @param {unknown} value - Raw header value.
 * @returns {string|null} Canonical strategy id, or null for "no override".
 */
export function parseAccountStrategy(value) {
  if (!isString(value)) return null;
  const text = value.trim().toLowerCase();
  if (!text) return null;
  return ACCOUNT_STRATEGIES.includes(text) ? text : null;
}

/**
 * @param {unknown} value - Strategy id from settings or a request override.
 * @returns {boolean} True when account selection advances round-robin style.
 */
export function isRoundRobinStrategy(value) {
  return isString(value) && ROUND_ROBIN_STRATEGIES.includes(value);
}
