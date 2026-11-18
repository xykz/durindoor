import { isString } from "./typeChecks.js";

/**
 * Per-request account-selection strategies asked for with `x-account-strategy`.
 *
 * Two strategies live here, both modelled on magpie's routing (`usage` and
 * `expiring`) but expressed against provider-reported quota snapshots:
 *
 * - `least-used`        — order accounts by the share of their allowance already
 *                         spent, least spent first. Accounts whose share cannot
 *                         be read sit after the readable ones that still have
 *                         room and before the ones running low or spent, so an
 *                         unread account can never masquerade as an unused one.
 * - `use-before-expiry` — order accounts by when the allowance still on them is
 *                         lost, soonest first, so a pack that is about to reset
 *                         is spent before a pack that renews later.
 *
 * The header is deliberately scoped: only the providers listed in
 * ACCOUNT_STRATEGY_PROVIDERS honour it. Selection for every other provider is
 * unchanged, so a caller cannot reshape routing for a provider whose quota
 * shape this module does not understand.
 */
export const ACCOUNT_STRATEGIES = Object.freeze(["least-used", "use-before-expiry"]);

/** Providers whose account selection these strategies may reorder. */
export const ACCOUNT_STRATEGY_PROVIDERS = Object.freeze(["codebuddy-cn"]);

/**
 * Parse an `x-account-strategy` header value into a canonical strategy id.
 *
 * @param {unknown} value - Raw header value.
 * @returns {string|null} Canonical strategy id, or null when absent/unknown.
 */
export function parseAccountStrategy(value) {
  if (!isString(value)) return null;
  const text = value.trim().toLowerCase();
  if (!text) return null;
  return ACCOUNT_STRATEGIES.includes(text) ? text : null;
}

/**
 * Whether a strategy may reorder this provider's accounts.
 *
 * @param {string|null} provider - Resolved provider id.
 * @param {string|null} strategy - Canonical strategy id from parseAccountStrategy.
 * @returns {boolean}
 */
export function accountStrategyAppliesTo(provider, strategy) {
  if (!provider || !strategy) return false;
  if (!ACCOUNT_STRATEGIES.includes(strategy)) return false;
  return ACCOUNT_STRATEGY_PROVIDERS.includes(provider);
}
