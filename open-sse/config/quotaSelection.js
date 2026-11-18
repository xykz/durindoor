import {
  CODEX_SSE_PEEK_TIMEOUT_MS,
  PROVIDER_BODY_TIMEOUT_MS,
  STREAM_FIRST_CHUNK_TIMEOUT_MS,
  STREAM_STALL_TIMEOUT_MS } from
"./runtimeConfig.js";
import { isBoolean, isNumber, isObject } from "../../src/shared/utils/typeChecks.js";

export const QUOTA_SELECTION_DEFAULTS = Object.freeze({
  routingFloorEnabled: false,
  routingFloorRatio: 0.02,
  lowRatio: 0.20,
  routingFloorEpsilon: 1e-9,
  // Share-of-allowance tiers for header-driven account ordering. These are
  // deliberately separate from `lowRatio`: that one is a provider-capacity
  // threshold used by scoring, these two decide how a header-driven strategy
  // groups accounts. 0.9 / 0.98 are the tiers magpie's LeastUsed uses.
  usageLowShare: 0.9,
  usageSpentShare: 0.98,
  // How often a provider's whole pool may be re-read in the background while
  // requests are being routed. Routing never waits for these reads.
  poolRefreshIntervalMs: 60 * 1000,
  starvationMs: 5 * 60 * 1000,
  heartbeatMs: 30 * 1000,
  leaseMs: Math.max(
    CODEX_SSE_PEEK_TIMEOUT_MS,
    STREAM_STALL_TIMEOUT_MS,
    STREAM_FIRST_CHUNK_TIMEOUT_MS,
    PROVIDER_BODY_TIMEOUT_MS
  ) + 60 * 1000,
  maxLeaseMs: 24 * 60 * 60 * 1000,
  terminalRetentionMs: 24 * 60 * 60 * 1000,
  maxItems: 16
});

function booleanOr(value, fallback) {
  return isBoolean(value) ? value : fallback;
}

function ratioOr(value, fallback) {
  return isNumber(value) && Number.isFinite(value) && value >= 0 && value <= 1 ?
  value :
  fallback;
}

function scopedConfig(config, key) {
  const value = config?.[key];
  return value && isObject(value) && !Array.isArray(value) ? value : null;
}

/**
 * Resolve the optional routing floor without conflating it with hard capacity.
 * Precedence is connection/window, provider/window, then global settings.
 */
export function resolveQuotaRoutingFloor(config = {}, {
  connectionId,
  provider,
  dimensionKey
} = {}) {
  const connection = scopedConfig(scopedConfig(config, "connections"), connectionId);
  const providerConfig = scopedConfig(scopedConfig(config, "providers"), provider);
  const connectionWindow = scopedConfig(scopedConfig(connection, "dimensions"), dimensionKey);
  const providerWindow = scopedConfig(scopedConfig(providerConfig, "dimensions"), dimensionKey);
  const candidates = [connectionWindow, connection, providerWindow, providerConfig, config];

  let enabled = QUOTA_SELECTION_DEFAULTS.routingFloorEnabled;
  let ratio = QUOTA_SELECTION_DEFAULTS.routingFloorRatio;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (isBoolean(candidate.routingFloorEnabled)) {
      enabled = booleanOr(candidate.routingFloorEnabled, enabled);
      break;
    }
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (isNumber(candidate.routingFloorRatio) &&
    Number.isFinite(candidate.routingFloorRatio) &&
    candidate.routingFloorRatio >= 0 &&
    candidate.routingFloorRatio <= 1) {
      ratio = ratioOr(candidate.routingFloorRatio, ratio);
      break;
    }
  }
  return { enabled, ratio };
}

export function resolveQuotaLeaseMs(value) {
  return Number.isSafeInteger(value) &&
  value >= QUOTA_SELECTION_DEFAULTS.heartbeatMs * 2 &&
  value <= QUOTA_SELECTION_DEFAULTS.maxLeaseMs ?
  value :
  QUOTA_SELECTION_DEFAULTS.leaseMs;
}

/**
 * Resolve the pool-refresh interval for one provider.
 *
 * Routing re-reads a provider's whole quota pool in the background at most this
 * often while requests are in flight; no timer runs without traffic. The value
 * is a provider setting (`quotaSelection.providers.<id>.poolRefreshIntervalMs`)
 * falling back to the global one.
 */
export function resolvePoolRefreshIntervalMs(config = {}, provider = null) {
  const providerConfig = scopedConfig(scopedConfig(config, "providers"), provider);
  for (const candidate of [providerConfig, config]) {
    const value = candidate?.poolRefreshIntervalMs;
    if (isNumber(value) && Number.isSafeInteger(value) && value >= 0) return value;
  }
  return QUOTA_SELECTION_DEFAULTS.poolRefreshIntervalMs;
}
