/**
 * CodeBuddy CN CLI fingerprint — single source for every request DurinDoor makes
 * to copilot.tencent.com, and for every header the official CLI
 * (`@tencent-ai/codebuddy-code`) derives from its own product config.
 *
 * Why this module exists: the CLI builds its User-Agent, X-IDE-Version and
 * conversation/request identity headers from one version constant. DurinDoor
 * used to hardcode three different, stale version strings in three places
 * (chat transport, OAuth flow, quota fetcher). Deriving all of them here means
 * one bump updates the whole surface.
 *
 * Observed against @tencent-ai/codebuddy-code 2.172.1 (product.json dated
 * 2026-10-21). See docs/providers/codebuddy-cn.md for the alignment contract and
 * for the headers DurinDoor deliberately does NOT mirror.
 */

import { createHash, randomUUID } from "crypto";
import { isString } from "../../src/shared/utils/typeChecks.js";

/** CLI release this fingerprint mirrors. Bump when the CLI's UA changes. */
export const CODEBUDDY_CLI_VERSION = "2.172.1";

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Effective CLI version. `CODEBUDDY_CLI_VERSION` overrides the pinned value so an
 * operator can track a newer CLI without a release; invalid values fall back.
 *
 * @returns {string} A dotted semver triple.
 */
export function codebuddyCliVersion() {
  const raw = process.env.CODEBUDDY_CLI_VERSION?.trim();
  if (raw && VERSION_RE.test(raw)) return raw;
  return CODEBUDDY_CLI_VERSION;
}

/**
 * Official CLI builds this as `buildUserAgent()`: platform/version + product/version
 * joined by a space. Result: `CLI/2.172.1 CodeBuddy/2.172.1`.
 *
 * @param {string} [version] - Explicit version; defaults to {@link codebuddyCliVersion}.
 * @returns {string} The User-Agent the CLI sends on chat requests.
 */
export function codebuddyUserAgent(version) {
  const v = isString(version) && VERSION_RE.test(version) ? version : codebuddyCliVersion();
  return `CLI/${v} CodeBuddy/${v}`;
}

/**
 * `cache_retention` default for chat requests.
 *
 * The CLI latches `"long"` per session unless `CODEBUDDY_DISABLE_PROMPT_CACHING_1H`
 * is truthy, in which case it latches `"short"`. DurinDoor has no session object to
 * latch onto, so the value is computed per request from the same env switch.
 *
 * @returns {"long"|"short"} The retention mode to send upstream.
 */
export function codebuddyCacheRetention() {
  const raw = process.env.CODEBUDDY_DISABLE_PROMPT_CACHING_1H?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return "short";
  return "long";
}

/**
 * Per-request identifier in the CLI's shape: a UUID with the dashes stripped
 * (32 lowercase hex characters). Used for X-Request-ID and the conversation
 * request/message ids.
 *
 * @returns {string} 32 hex characters.
 */
export function codebuddyRequestId() {
  return randomUUID().replace(/-/g, "").toLowerCase();
}

/**
 * Conversation identifier for X-Conversation-ID.
 *
 * The CLI sends its session UUID verbatim. DurinDoor's session ids come from
 * `resolveSessionId` and are either a client-supplied id (any shape) or a
 * generated `uuid + timestamp` string, so anything that is not already a UUID
 * is hashed into a stable UUID-v4-shaped value. The same seed therefore always
 * yields the same conversation id, and a different seed a different one.
 *
 * @param {string} [seed] - Session or connection identifier.
 * @returns {string} A UUID-shaped conversation id.
 */
export function codebuddyConversationId(seed) {
  const value = isString(seed) ? seed.trim() : "";
  if (value && UUID_RE.test(value)) return value.toLowerCase();
  const digest = createHash("sha256").update(`codebuddy-cn:${value || "anonymous"}`).digest("hex");
  // Force version 4 / RFC-4122 variant nibbles so the result is a valid UUID.
  const variant = ((parseInt(digest[16], 16) & 0x3) | 0x8).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/**
 * Whether CLI-alignment headers and body fields are applied.
 *
 * `CODEBUDDY_CLI_ALIGNMENT=off` is the one-line rollback if a future upstream
 * change starts rejecting the mirrored fingerprint: the request falls back to
 * the pre-alignment header set without needing a version rollback.
 *
 * @returns {boolean} True unless the operator opted out.
 */
export function codebuddyCliAlignmentEnabled() {
  return process.env.CODEBUDDY_CLI_ALIGNMENT?.trim().toLowerCase() !== "off";
}
