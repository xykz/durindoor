import { QUOTA_SELECTION_DEFAULTS } from "open-sse/config/quotaSelection.js";
import { isNumber, isString } from "@/shared/utils/typeChecks.js";

/**
 * Keep a provider's whole quota pool warm without ever blocking a request.
 *
 * Account ordering by allowance (`least-used`, `use-before-expiry`) is only as
 * good as the readings it sorts. Two properties of the existing tracker made
 * that ordering useless in practice:
 *
 * 1. a reading whose account was not just selected is stale until something
 *    else reads it — the preflight wrapper only refreshes the account it is
 *    about to use, so the rest of the pool is never re-read; and
 * 2. `freshnessMs` used to be 60s, so a reading could expire between two
 *    refreshes and the account fell back to "unknown".
 *
 * This module fixes (1) the way magpie does (`internal/provider/routing.go`:
 * "asked for again in the background when that was over a minute ago"): while
 * requests are being routed, at most one background read per provider is in
 * flight, and a provider is re-read at most once per interval. No request waits
 * for it, and no timer runs when no requests arrive — an idle gateway never
 * touches the vendor.
 *
 * Failures are swallowed: a failed background read leaves the previous readings
 * in place, which is exactly the state routing already tolerates.
 */

const poolState = new Map();

function stateFor(provider) {
  let state = poolState.get(provider);
  if (!state) {
    state = { startedAt: 0, inflight: false, failures: 0 };
    poolState.set(provider, state);
  }
  return state;
}

/**
 * Schedule a whole-pool background refresh for one provider.
 *
 * @param {object} options
 * @param {string} options.provider - Resolved provider id.
 * @param {object[]} options.connections - Connections whose readings to refresh.
 * @param {Function} options.refresh - `refreshProviderQuota(connection, opts)`.
 * @param {number} [options.now] - Epoch milliseconds.
 * @param {number} [options.intervalMs] - Minimum gap between two pool reads.
 * @param {Function} [options.onError] - Diagnostics hook; never throws.
 * @returns {boolean} Whether a read was started.
 */
export function schedulePoolRefresh({
  provider,
  connections,
  refresh,
  now = Date.now(),
  intervalMs = QUOTA_SELECTION_DEFAULTS.poolRefreshIntervalMs,
  onError = null,
} = {}) {
  if (!isString(provider) || !provider) return false;
  if (typeof refresh !== "function") return false;
  const list = Array.isArray(connections) ? connections.filter((entry) => entry?.id) : [];
  if (list.length === 0) return false;

  const state = stateFor(provider);
  if (state.inflight) return false;
  if (Number.isFinite(intervalMs) && intervalMs > 0 && now - state.startedAt < intervalMs) {
    return false;
  }

  state.startedAt = now;
  state.inflight = true;
  // Sequential, not parallel: a burst of simultaneous reads at the vendor is
  // the one thing that turns a background refresh into a rate limit.
  void (async () => {
    try {
      for (const connection of list) {
        try {
          await refresh(connection, { force: true });
        } catch {
          // Per-account failure is local to that account's reading.
        }
      }
      state.failures = 0;
    } catch (error) {
      state.failures += 1;
      if (typeof onError === "function") {
        try {
          onError(error);
        } catch {
          // Diagnostics must never escape a background task.
        }
      }
    } finally {
      state.inflight = false;
    }
  })();

  return true;
}

/**
 * Whether a pool read is currently in flight (diagnostics and tests).
 */
export function isPoolRefreshInflight(provider) {
  return poolState.get(provider)?.inflight === true;
}

/** Clear all scheduling state (tests, and a disconnect that drops every pool). */
export function resetPoolRefreshState() {
  poolState.clear();
}

/**
 * Decide whether an upstream refusal is evidence about the account's allowance,
 * in which case its reading should be renewed at once rather than waiting for
 * the next pool cycle.
 *
 * A rate limit or a quota refusal says something about the allowance; a plain
 * 5xx, a bad request, or a transport failure does not.
 *
 * @param {number} status - Upstream HTTP status.
 * @param {string|null} provider - Resolved provider id.
 * @returns {boolean}
 */
export function refusalRefreshesAllowance(status, provider) {
  if (!isNumber(Number(status))) return false;
  const code = Number(status);
  if (!isString(provider) || !provider) return false;
  return code === 402 || code === 429;
}
