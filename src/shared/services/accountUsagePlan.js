import { QUOTA_SELECTION_DEFAULTS } from "open-sse/config/quotaSelection.js";
import { isNumber, isObject, isString } from "@/shared/utils/typeChecks.js";

/**
 * Turn-scoped account routing from provider-reported allowance readings.
 *
 * Two orderings are implemented here, both taken from magpie's routing
 * (`internal/routes/strategies.go`) and expressed against the quota snapshots
 * this gateway already persists:
 *
 * - `least-used`        (`LeastUsed`)        — the fullest window decides an
 *                         account's share spent; the least spent account wins.
 * - `use-before-expiry` (`FreeExpiring`)     — whatever allowance is left is
 *                         spent before it is lost, soonest loss first.
 *
 * Readings are used as they were last persisted. A window whose reset time has
 * passed is counted as renewed rather than as unknown, which is what lets a
 * stale reading still rank an account (`Allowance.For` does the same).
 *
 * Nothing here mutates a quota profile, a routing floor, or a persisted row:
 * the plan is a pure ordering consumed by account selection.
 */

const POSITIVE_STATES = new Set(["available", "low"]);
const SPENT_STATES = new Set(["exhausted", "cooldown"]);

/** Tiers, least favourable last. */
export const USAGE_TIER = Object.freeze({
  ROOM: "room",
  UNKNOWN: "unknown",
  LOW: "low",
  SPENT: "spent"
});

function timestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

function shareOf(row) {
  const explicit = row?.amounts?.remainingRatio;
  if (isNumber(explicit) && Number.isFinite(explicit) && explicit >= 0 && explicit <= 1) {
    return explicit;
  }
  const limit = row?.amounts?.limit;
  const remaining = row?.amounts?.remaining;
  if (
    isNumber(limit) && Number.isFinite(limit) && limit > 0 &&
    isNumber(remaining) && Number.isFinite(remaining) && remaining >= 0
  ) {
    return Math.min(1, Math.max(0, remaining / limit));
  }
  return null;
}

/**
 * One reading, adjusted for the moment it is being read at.
 *
 * A window past its reset has renewed: its allowance is whole again, whatever
 * the last reading said. A cooling account keeps its state — the cooldown is a
 * local fact, not an allowance amount.
 *
 * @param {object} row - Persisted quota snapshot row.
 * @param {number} now - Epoch milliseconds.
 * @returns {{remainingShare: number|null, expiresAt: number|null, spent: boolean}}
 */
export function readingAt(row, now) {
  const resetMs = timestamp(row?.timing?.resetAt);
  // A reset that has passed empties the window of its spend; the renewal time
  // itself is no longer an expiry, because the allowance it guarded is fresh.
  const renewed = resetMs !== null && resetMs <= now;
  const rawShare = shareOf(row);
  const remainingShare = renewed ? 1 : rawShare;
  const cooling = row?.state === "cooldown";
  const spent = cooling || (!renewed && SPENT_STATES.has(row?.state));
  const expiresAt = renewed ? null : resetMs;
  return { remainingShare, expiresAt, spent };
}

/**
 * Describe one account's allowance position from its own readings.
 *
 * The share spent is the fullest window's, not an average: the upstream refuses
 * once any single pool is empty, so the tightest pool is what the account can
 * actually still serve.
 *
 * @param {object[]} rows - Persisted snapshot rows for one connection.
 * @param {number} now - Epoch milliseconds.
 * @param {object} [config] - Threshold overrides.
 * @returns {{connectionId: string|null, known: boolean, usedShare: number|null,
 *   remainingShare: number|null, tier: string, expiresAt: number|null}}
 */
export function describeAccountUsage(rows, now, config = QUOTA_SELECTION_DEFAULTS) {
  const lowShare = isNumber(config?.usageLowShare) ? config.usageLowShare : QUOTA_SELECTION_DEFAULTS.usageLowShare;
  const spentShare = isNumber(config?.usageSpentShare) ? config.usageSpentShare : QUOTA_SELECTION_DEFAULTS.usageSpentShare;
  const list = Array.isArray(rows) ? rows : [];
  let usedShare = null;
  let expiredShare = null;
  let expiresAt = null;
  let spent = false;
  let connectionId = null;

  for (const row of list) {
    if (!connectionId && isString(row?.identity?.connectionId)) connectionId = row.identity.connectionId;
    const reading = readingAt(row, now);
    if (reading.spent) spent = true;
    if (reading.remainingShare !== null) {
      const used = 1 - reading.remainingShare;
      // A window that has renewed says nothing about what is still to be lost;
      // it only proves the account is not empty, so it participates weakly.
      if (reading.expiresAt === null) expiredShare = Math.max(expiredShare ?? used, used);
      else usedShare = Math.max(usedShare ?? used, used);
    }
    if (reading.expiresAt !== null && reading.remainingShare !== null && reading.remainingShare > 0) {
      expiresAt = expiresAt === null ? reading.expiresAt : Math.min(expiresAt, reading.expiresAt);
    }
  }

  const effective = usedShare ?? expiredShare;
  if (spent && effective === null) {
    return { connectionId, known: false, usedShare: 1, remainingShare: 0, tier: USAGE_TIER.SPENT, expiresAt };
  }
  if (effective === null) {
    return { connectionId, known: false, usedShare: null, remainingShare: null, tier: USAGE_TIER.UNKNOWN, expiresAt };
  }
  const tier = spent || effective >= spentShare ?
  USAGE_TIER.SPENT :
  effective >= lowShare ? USAGE_TIER.LOW : USAGE_TIER.ROOM;
  return {
    connectionId,
    known: true,
    usedShare: effective,
    remainingShare: 1 - effective,
    tier: spent && tier !== USAGE_TIER.SPENT ? USAGE_TIER.SPENT : tier,
    expiresAt
  };
}

function tierRank(tier, strategy) {
  if (strategy === "use-before-expiry") {
    // Only a truly empty or cooling account sinks. A nearly spent pack that is
    // about to be lost is exactly what should be burned first, which is where
    // this deliberately departs from magpie's free-seat partitioning.
    return tier === USAGE_TIER.SPENT ? 2 : 0;
  }
  if (tier === USAGE_TIER.ROOM) return 0;
  if (tier === USAGE_TIER.UNKNOWN) return 1;
  if (tier === USAGE_TIER.LOW) return 2;
  return 3;
}

function compareExpiry(left, right) {
  const a = left.expiresAt;
  const b = right.expiresAt;
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function compareUsed(left, right) {
  const a = left.usedShare;
  const b = right.usedShare;
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/**
 * Order accounts for one strategy.
 *
 * `least-used` reads like magpie's `LeastUsed`: the readable accounts with room
 * first by share spent, then the accounts nobody has told us about, then those
 * running low and those already spent. An unread account is never treated as an
 * unused one — that is how a paid balance gets drained while a subscription sits
 * idle (magpie #4535).
 *
 * `use-before-expiry` puts whatever still holds allowance in the order it is
 * lost. Inside a tier the soonest loss wins, then the account with more room,
 * because two packs that expire together waste the same amount whichever is
 * spent first — so the tie goes to whichever can still absorb the traffic
 * instead of the one about to run dry mid-request.
 *
 * Each strategy leads with its own key: share spent for `least-used` (`Used`
 * ascending), the loss time for `use-before-expiry` (`Expires`). A comparison
 * that leads with the wrong key would let an unknown expiry, or an unknown
 * share, decide the order for the other strategy.
 *
 * @param {object[]} accounts - Entries from describeAccountUsage plus `connection`.
 * @param {string} strategy - `least-used` or `use-before-expiry`.
 * @returns {object[]} New array, best candidate first.
 */
export function rankAccountUsage(accounts, strategy) {
  const byExpiry = strategy === "use-before-expiry";
  return [...accounts].sort((left, right) => {
    const tierDelta = tierRank(left.tier, strategy) - tierRank(right.tier, strategy);
    if (tierDelta !== 0) return tierDelta;
    const primaryDelta = byExpiry ? compareExpiry(left, right) : compareUsed(left, right);
    if (primaryDelta !== 0) return primaryDelta;
    const secondaryDelta = byExpiry ? compareUsed(left, right) : compareExpiry(left, right);
    if (secondaryDelta !== 0) return secondaryDelta;
    const priorityDelta = (left.connection?.priority ?? Number.MAX_SAFE_INTEGER) -
    (right.connection?.priority ?? Number.MAX_SAFE_INTEGER);
    if (priorityDelta !== 0) return priorityDelta;
    return String(left.connectionId || "").localeCompare(String(right.connectionId || ""));
  });
}

/**
 * Build the ordering for one provider's available connections.
 *
 * @param {object[]} connections - Connections already filtered for eligibility.
 * @param {object[]} snapshots - Persisted quota snapshots for the provider.
 * @param {{strategy: string, now?: number, config?: object}} options
 * @returns {object[]} Ordered `{connection, usage}` pairs, best first.
 */
export function planAccountUsage(connections, snapshots, { strategy, now = Date.now(), config = QUOTA_SELECTION_DEFAULTS } = {}) {
  const byConnection = new Map();
  for (const row of Array.isArray(snapshots) ? snapshots : []) {
    if (row?.provenance?.sourceType !== "provider_api") continue;
    const id = row?.identity?.connectionId;
    if (!isString(id)) continue;
    const bucket = byConnection.get(id);
    if (bucket) bucket.push(row);else byConnection.set(id, [row]);
  }
  const accounts = (connections || []).map((connection) => ({
    ...describeAccountUsage(byConnection.get(connection.id) || [], now, config),
    connection,
    connectionId: connection.id,
  }));
  return rankAccountUsage(accounts, strategy);
}

/**
 * Read user turns out of a request body, in magpie's sense of a turn.
 *
 * A user message that carries only tool results keeps the current turn open —
 * that is an agent still working through one task. Any user message with words
 * of its own (or a fresh attachment) opens a new turn. The count is the turn
 * signature: while it does not move, a request continues the same turn.
 *
 * @param {object|null} body - Request body (OpenAI, Claude, or Responses shape).
 * @returns {number|null} Number of user turns, or null when unreadable.
 */
export function countConversationTurns(body) {
  const messages = Array.isArray(body?.messages) ?
  body.messages :
  Array.isArray(body?.input) ? body.input : null;
  if (!messages) return null;
  const limit = Math.min(messages.length, 1000);
  let turns = 0;
  for (let index = 0; index < limit; index += 1) {
    const message = messages[index];
    if (!message) continue;
    // A tool result is its own message in the chat shape and never opens a turn.
    if (message.role === "tool" || message.role === "function") continue;
    if (message.role !== "user") continue;
    if (saysSomething(message)) turns += 1;
  }
  return turns;
}

function saysSomething(message) {
  const content = message?.content;
  if (isString(content)) return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  for (const part of content) {
    if (!part || isObject(part) === false) continue;
    // Tool output carries the agent's own continuation, not the user's words.
    if (part.type === "tool_result") continue;
    // An attachment is the user's, even when the words are the tool's.
    if (part.type === "image" || part.type === "image_url" || part.type === "file" || part.type === "document") {
      return true;
    }
    if (isString(part.text) && part.text.trim().length > 0) return true;
    if (isString(part.content) && part.content.trim().length > 0 && part.type !== "tool_result") return true;
  }
  return false;
}
