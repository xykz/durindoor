/**
 * Parse a per-request per-account concurrency cap from a client header value.
 *
 * Used by `x-account-concurrency`. The dashboard's `Max Concurrent` control is
 * provider-wide — one semaphore shared by every account of the provider — while
 * upstream providers (e.g. CodeBuddy CN) throttle per ACCOUNT, model-independent.
 * Sizing the provider gate for the whole pool therefore leaves most of the
 * upstream allowance unused, and sizing it high lets a single account take the
 * entire pool's burst. This header supplies the real per-account ceiling for one
 * request without touching the dashboard.
 *
 * When the header is present the router gates on `${provider}:${connectionId}`
 * and SKIPS the provider-wide gate for that request; a provider-wide semaphore in
 * series with an account-level one would clamp the pool to the provider value and
 * make the header a no-op. When absent, selection and gating behave exactly as
 * before.
 *
 * Accepted forms:
 * - `3` / ` 3 ` / `1` — bare positive integers (whole requests, no fractions)
 * - blank, zero, negative, fractional, or malformed → `null` (no override)
 *
 * @see docs/features/smart-routing.md
 * @module src/shared/utils/accountConcurrency
 */

import { isNumber, isString } from "./typeChecks.js";

/** Hard upper bound; keeps a typo from parking a request forever on one account. */
export const MAX_ACCOUNT_CONCURRENCY = 64;

function bounded(value) {
  if (!Number.isSafeInteger(value)) return null;
  if (value <= 0) return null;
  return Math.min(value, MAX_ACCOUNT_CONCURRENCY);
}

/**
 * @param {unknown} value - Raw header value.
 * @returns {number|null} Positive integer per-account limit, or null for "no override".
 */
export function parseAccountConcurrency(value) {
  if (isNumber(value)) return Number.isFinite(value) ? bounded(value) : null;
  if (!isString(value)) return null;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  return bounded(Number(text));
}

/**
 * Semaphore key for one account's slot pool.
 *
 * Namespaced so an account key can never collide with a bare provider key (the
 * provider gate uses the provider id itself).
 *
 * @param {string} provider - Resolved provider id.
 * @param {string} connectionId - Selected connection id.
 * @returns {string|null} Composite gate key, or null when either part is missing.
 */
export function accountConcurrencyKey(provider, connectionId) {
  if (!isString(provider) || !provider) return null;
  if (!isString(connectionId) || !connectionId) return null;
  return `${provider}:${connectionId}`;
}

/**
 * Resolve which semaphore a dispatch should acquire, and at what limit.
 *
 * An account-level cap REPLACES the provider-wide one for that request: the two
 * gates are independent semaphores, so keeping both in series would clamp the
 * pool to the provider value and make the account limit unreachable.
 *
 * @param {object} params - Gate inputs.
 * @param {string} params.provider - Resolved provider id (the provider-wide key).
 * @param {string|null} params.connectionId - Selected connection id.
 * @param {unknown} params.providerConcurrencyLimit - Dashboard `Max Concurrent` map.
 * @param {number} params.accountConcurrencyLimit - Parsed per-account cap, 0 when absent.
 * @param {function} params.providerLimitOf - Resolves the provider-wide limit.
 * @returns {{key: string|null, limit: number, scope: "provider"|"account"}} Gate plan.
 */
export function resolveConcurrencyGate({
  provider,
  connectionId,
  providerConcurrencyLimit,
  accountConcurrencyLimit,
  providerLimitOf
}) {
  const accountKey = accountConcurrencyLimit > 0 ?
  accountConcurrencyKey(provider, connectionId) :
  null;
  if (accountKey) {
    return { key: accountKey, limit: accountConcurrencyLimit, scope: "account" };
  }
  return {
    key: provider,
    limit: providerLimitOf(provider, providerConcurrencyLimit),
    scope: "provider"
  };
}
