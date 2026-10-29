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
 * Observed against @tencent-ai/codebuddy-code 2.138.0 (product.json dated
 * 2026-08-24). That release is user-agent-identifiable as a real CLI build that
 * thousands of installs still run, and — the reason it was chosen over the newer
 * ones — it predates the UUIDv7 switch: every session, message and request id it
 * sends is an ordinary UUIDv4 (version nibble `4`) carrying no embedded
 * timestamp, so DurinDoor never has to counterfeit a clock to look like it.
 * Upstream started minting UUIDv7 in 2.146.0 and only began validating the shape
 * in 2.177.0; mirroring anything from that range forces a synthesized timestamp
 * into the conversation id. See docs/providers/codebuddy-cn.md for the alignment
 * contract, the version history, and the headers DurinDoor deliberately does NOT
 * mirror.
 */

import { createHash, randomBytes } from "crypto";
import { isObject, isString } from "../../src/shared/utils/typeChecks.js";

/** CLI release this fingerprint mirrors. Bump when the CLI's UA changes. */
export const CODEBUDDY_CLI_VERSION = "2.138.0";

/**
 * Version of the `openai` npm package the CLI bundles. Surfaces as
 * `X-Stainless-Package-Version`; the value is a literal in the CLI's SDK copy
 * (`X-Stainless-Package-Version: "6.25.0"`), not derived from its config.
 */
export const CODEBUDDY_SDK_PACKAGE_VERSION = "6.25.0";

const VERSION_RE = /^\d+\.\d+\.\d+$/;
/** Any dashed UUID, which the CLI forwards verbatim as its session id. */
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
 * joined by a space. Result: `CLI/<v> CodeBuddy/<v>`, e.g.
 * `CLI/2.138.0 CodeBuddy/2.138.0` at the pinned version.
 *
 * @param {string} [version] - Explicit version; defaults to {@link codebuddyCliVersion}.
 * @returns {string} The User-Agent the CLI sends on chat requests.
 */
export function codebuddyUserAgent(version) {
  const v = isString(version) && VERSION_RE.test(version) ? version : codebuddyCliVersion();
  return `CLI/${v} CodeBuddy/${v}`;
}

// --- UUIDv4 assembly -------------------------------------------------------
// 2.138.0 mints its session, message and request ids with `generateUUUID()`,
// which is `crypto.randomUUID.bind(crypto)` — an ordinary random (version 4)
// UUID with no embedded clock. That is the whole reason this release is the
// mirror target: a gateway can produce a byte-indistinguishable id from pure
// randomness, whereas the CLI's later `uuidv7()` ids lead with a 48-bit
// timestamp, so any gateway-side id either carries a real "session started now"
// clock or a hashed one that decodes to a nonsense year.
//
// Upstream also had no format assertion on these ids in 2.138.0
// (`conversationRequestId must be a lowercase UUIDv7 …` first appears in
// 2.177.0), so nothing downstream constrains the version nibble either.

/**
 * Stamps the UUIDv4 version and RFC-4122 variant nibbles onto 32 hex chars.
 *
 * @param {string} hex - At least 32 hex characters of entropy.
 * @returns {string} 32 lowercase hex characters in UUIDv4 shape.
 */
function asUuidV4Hex(hex) {
  const chars = hex.slice(0, 32).split("");
  chars[12] = "4";
  const variant = ((parseInt(chars[16], 16) || 0) & 0x3) | 0x8;
  chars[16] = variant.toString(16);
  return chars.join("");
}

/**
 * Formats 32 hex characters as a dashed UUID.
 *
 * @param {string} hex - 32 lowercase hex characters.
 * @returns {string} `8-4-4-4-12` layout.
 */
function dashUuid(hex) {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Dash-stripped UUIDv4, the shape the CLI sends on X-Request-ID and
 * X-Conversation-Message-ID (which it always sets to the same value) and on
 * X-Conversation-Request-ID.
 *
 * @returns {string} 32 hex characters, version nibble `4`.
 */
function uuidV4Hex() {
  return asUuidV4Hex(randomBytes(16).toString("hex"));
}

/**
 * Per-request identifier: MESSAGE id, sent on both X-Request-ID and
 * X-Conversation-Message-ID.
 *
 * @returns {string} 32 hex characters in UUIDv4 shape.
 */
export function codebuddyRequestId() {
  return uuidV4Hex();
}

/**
 * Conversation identifier for X-Conversation-ID.
 *
 * The CLI sends its session id verbatim, whatever its shape, so a client-supplied
 * value is passed through unchanged (a capture with `--session-id arbitrary_session-42`
 * went upstream as `x-conversation-id: arbitrary_session-42`). Anything else is
 * hashed into a stable dashed UUIDv4, because DurinDoor's session ids come from
 * `resolveSessionId` (a client-supplied id of any shape, or a generated
 * `uuid + timestamp` string) and a stable conversation id is what keeps the
 * gateway's turns grouped. Hashing yields no timestamp, so nothing in the id
 * reveals that a gateway rather than the CLI minted it.
 *
 * @param {string} [seed] - Session or connection identifier.
 * @returns {string} A dashed UUIDv4, or the seed itself when it is already a UUID.
 */
export function codebuddyConversationId(seed) {
  const value = isString(seed) ? seed.trim() : "";
  if (value && UUID_RE.test(value)) return value;
  const digest = createHash("sha256")
    .update(`codebuddy-cn:${value.toLowerCase() || "anonymous"}`)
    .digest("hex");
  return dashUuid(asUuidV4Hex(digest));
}

/**
 * A fresh trace context, as the CLI's OTEL span produces it.
 *
 * The CLI's `injectOtelSpanHeaders()` derives all seven trace headers from one
 * span context, and it seeds that span's trace id from the conversation request
 * id (`traceId` falls back to `crypto.randomBytes(16).toString("hex")` and is then
 * written to `traceId`, `conversationRequestId` and `lastConversationTraceId`
 * alike). A captured 2.138.0 request therefore carried
 * `x-conversation-request-id === x-root-request-id === x-b3-traceid === x-trace-id`
 * — one value under four names. Minting them separately is the one thing a real
 * CLI can never do.
 *
 * `sampled` is always 1: the CLI's model-call span is created with the default
 * sampler, and every capture showed `x-b3-sampled: 1` with traceparent flags
 * `-01`.
 *
 * @returns {{traceId: string, spanId: string, parentSpanId: string, sampled: boolean}}
 *   32 hex trace id, 16 hex span id, 16 hex parent span id (the CLI always has a
 *   parent: the run's root span), and the sampled flag.
 */
export function codebuddyTraceContext() {
  return {
    traceId: randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
    parentSpanId: randomBytes(8).toString("hex"),
    sampled: true,
  };
}

/**
 * The seven W3C/B3 headers the CLI stamps from one span context.
 *
 * Mirrors `injectOtelSpanHeaders()` verbatim, including the B3 single-header
 * parent suffix: `b3` is only four hyphen-separated parts because the CLI always
 * passes a parent span id here.
 *
 * @param {{traceId: string, spanId: string, parentSpanId: string, sampled: boolean}} ctx
 *   Trace context from {@link codebuddyTraceContext}.
 * @returns {object} Header name/value pairs.
 */
export function codebuddyTraceHeaders(ctx) {
  const { traceId, spanId, parentSpanId, sampled } = ctx;
  const flag = sampled ? "1" : "0";
  const headers = {
    traceparent: `00-${traceId}-${spanId}-${sampled ? "01" : "00"}`,
    b3: `${traceId}-${spanId}-${flag}${parentSpanId ? `-${parentSpanId}` : ""}`,
    "X-B3-TraceId": traceId,
    "X-B3-SpanId": spanId,
    "X-B3-Sampled": flag,
    "X-Trace-ID": traceId,
  };
  if (parentSpanId) headers["X-B3-ParentSpanId"] = parentSpanId;
  return headers;
}

/**
 * `X-Stainless-OS` value: the OpenAI SDK's `normalizePlatform()` mapping.
 *
 * @param {string} [platform] - Defaults to `process.platform`.
 * @returns {string} SDK-normalized platform name.
 */
export function codebuddyStainlessOs(platform) {
  const raw = isString(platform) && platform ? platform : process.platform;
  const value = raw.toLowerCase();
  if (value.includes("ios")) return "iOS";
  if (value === "android") return "Android";
  if (value === "darwin") return "MacOS";
  if (value === "win32") return "Windows";
  if (value === "freebsd") return "FreeBSD";
  if (value === "openbsd") return "OpenBSD";
  if (value === "linux") return "Linux";
  return value ? `Other:${raw}` : "Unknown";
}

/**
 * `X-Stainless-Arch` value: the OpenAI SDK's `normalizeArch()` mapping.
 *
 * @param {string} [arch] - Defaults to `process.arch`.
 * @returns {string} SDK-normalized architecture name.
 */
export function codebuddyStainlessArch(arch) {
  const raw = isString(arch) && arch ? arch : process.arch;
  if (raw === "x32") return "x32";
  if (raw === "x86_64" || raw === "x64") return "x64";
  if (raw === "arm") return "arm";
  if (raw === "aarch64" || raw === "arm64") return "arm64";
  return raw ? `other:${raw}` : "unknown";
}

/**
 * Decode a JWT payload without verifying the signature.
 *
 * The token has already been validated by the upstream — DurinDoor is reading
 * claims to *describe* the caller, not to authenticate them, exactly as the CLI
 * does with its own stored token. A malformed token yields null rather than
 * throwing, so a caller can safely treat identity as unknown.
 *
 * @param {string} token - Raw bearer token, with or without the `Bearer ` prefix.
 * @returns {object|null} Decoded claims, or null when the token is unreadable.
 */
function decodeJwtClaims(token) {
  if (!isString(token) || !token) return null;
  const raw = token.startsWith("Bearer ") ? token.slice(7) : token;
  const parts = raw.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    const claims = JSON.parse(payload);
    return claims !== null && isObject(claims) && !Array.isArray(claims) ? claims : null;
  } catch {
    return null;
  }
}

/**
 * Identity headers the CLI derives from its authenticated session.
 *
 * A captured request made with a real account token carried
 * `X-User-Id: <token sub>` and `X-Domain: <iss host>`; the same request made
 * without a token carried neither, and `X-User-Id` degraded to `anonymous`.
 * That establishes both headers as token-derived rather than constants.
 *
 * `enterpriseId` follows the CLI's own `tryExtractUserIDFromJWTToken()`: only an
 * issuer whose last path segment starts with `sso-` denotes an enterprise
 * account, and the id is that segment with the prefix stripped. A regular
 * consumer account (`.../realms/copilot`) has no enterprise id.
 *
 * `X-Enterprise-Id` / `X-Tenant-Id` / `X-Private-Data` are emitted only when an
 * enterprise id exists, matching a capture of the enterprise branch, where
 * `X-Private-Data` flipped from `false` to `true` because model optimization is
 * force-disabled for enterprise accounts.
 *
 * `X-Userinfo`, `X-Auth-Method` and `X-Id-Source` are NOT produced: the CLI
 * populates them from login-flow metadata (auth method, id source) that a stored
 * OAuth token does not carry, and both captures confirmed their absence.
 *
 * @param {string} accessToken - The account's access token.
 * @param {string} [apiKey] - The account's API key, used when the token is opaque.
 * @returns {object} Header name/value pairs; empty when there is no identity.
 */
export function codebuddyIdentityHeaders(accessToken, apiKey) {
  const claims = decodeJwtClaims(accessToken);
  if (!claims) {
    // The CLI's API-key storage has no claims to read and falls back to a
    // pseudonymous id built from the key's last eight characters. A captured
    // API-key run carried exactly that, and no X-Domain, so this branch stays
    // narrow on purpose: an id, nothing else.
    return isString(apiKey) && apiKey ?
      { "X-User-Id": `anonymous_${apiKey.slice(-8)}` } :
      {};
  }

  const headers = {};
  if (isString(claims.sub) && claims.sub) headers["X-User-Id"] = claims.sub;

  if (isString(claims.iss) && claims.iss) {
    try {
      headers["X-Domain"] = new URL(claims.iss).hostname;
    } catch {
      // A non-URL issuer simply yields no domain, as in the CLI's own fallback.
    }
    const lastSegment = claims.iss.split("/").pop() || "";
    if (lastSegment.startsWith("sso-")) {
      const enterpriseId = lastSegment.slice(4);
      if (enterpriseId) {
        headers["X-Enterprise-Id"] = enterpriseId;
        headers["X-Tenant-Id"] = enterpriseId;
        // resolveModelOptimizationEnabled() returns false for enterprise
        // accounts, and the private-data flag is that value inverted.
        headers["X-Private-Data"] = "true";
      }
    }
  }
  return headers;
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
