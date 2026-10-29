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
 * Observed against @tencent-ai/codebuddy-code 2.177.0 (product.json dated
 * 2026-10-26), which is the release with the highest npm download volume and
 * therefore the shape the gateway sees most often. See
 * docs/providers/codebuddy-cn.md for the alignment contract, the version
 * history, and the headers DurinDoor deliberately does NOT mirror.
 */

import { createHash, randomBytes } from "crypto";
import { isString } from "../../src/shared/utils/typeChecks.js";

/** CLI release this fingerprint mirrors. Bump when the CLI's UA changes. */
export const CODEBUDDY_CLI_VERSION = "2.177.0";

/**
 * Version of the `openai` npm package the CLI bundles. Surfaces as
 * `X-Stainless-Package-Version`; the value is a literal in the CLI's SDK copy
 * (`X-Stainless-Package-Version: "6.25.0"`), not derived from its config.
 */
export const CODEBUDDY_SDK_PACKAGE_VERSION = "6.25.0";

const VERSION_RE = /^\d+\.\d+\.\d+$/;
/** Dashed UUIDv7, the shape the CLI uses for its session (X-Conversation-ID). */
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
 * joined by a space. Result: `CLI/2.177.0 CodeBuddy/2.177.0`.
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

// --- UUIDv7 assembly -------------------------------------------------------
// The CLI mints both its session id and its message/request ids with `uuidv7()`
// (a 48-bit millisecond timestamp, then version `7`, then 74 random bits). The
// gateway validates that nibble pattern on conversation request ids, so UUIDv4
// values — what DurinDoor used to send — do not match the CLI's shape.

/**
 * Stamps the UUIDv7 version and RFC-4122 variant nibbles onto 32 hex chars.
 *
 * @param {string} hex - 32 lowercase hex characters (timestamp + randomness).
 * @returns {string} 32 lowercase hex characters in UUIDv7 shape.
 */
function asUuidV7Hex(hex) {
  const chars = hex.slice(0, 32).split("");
  chars[12] = "7";
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
 * Current millisecond clock as the 12 hex characters a UUIDv7 starts with.
 *
 * @returns {string} 12 lowercase hex characters.
 */
function uuidV7Timestamp() {
  return Date.now().toString(16).padStart(12, "0").slice(-12);
}

/**
 * Per-request identifier in the CLI's shape: a UUIDv7 with the dashes stripped
 * (32 lowercase hex characters, version nibble `7`). Used for both X-Request-ID
 * and X-Conversation-Message-ID, which the CLI always sets to the same value.
 *
 * @returns {string} 32 hex characters in UUIDv7 shape (version nibble `7`).
 */
export function codebuddyRequestId() {
  const random = randomBytes(10).toString("hex");
  return asUuidV7Hex(`${uuidV7Timestamp()}${random}`);
}

/**
 * Conversation identifier for X-Conversation-ID.
 *
 * The CLI sends its session UUIDv7 verbatim, so a client-supplied UUIDv7 is
 * passed through unchanged. Anything else — a non-UUID session id, or a UUID of
 * a different version — is hashed into a stable UUIDv7-shaped value, because the
 * gateway expects the CLI's shape and DurinDoor's session ids come from
 * `resolveSessionId` (client-supplied id of any shape, or a generated
 * `uuid + timestamp` string). The same seed therefore always yields the same
 * conversation id, and a different seed a different one.
 *
 * @param {string} [seed] - Session or connection identifier.
 * @returns {string} A dashed UUIDv7-shaped conversation id.
 */
export function codebuddyConversationId(seed) {
  const value = isString(seed) ? seed.trim().toLowerCase() : "";
  if (value && UUID_V7_RE.test(value)) return value;
  const digest = createHash("sha256").update(`codebuddy-cn:${value || "anonymous"}`).digest("hex");
  return dashUuid(asUuidV7Hex(digest));
}

/**
 * Conversation request id for X-Conversation-Request-ID and X-Root-Request-ID.
 *
 * The CLI generates one per prompt (`generateConversationRequestId()`), sets it on
 * the session before the model call, and stamps the same value on both headers —
 * verified against a live 2.177.0 run, where the two headers were byte-identical.
 * It is a UUIDv7 with the dashes stripped, not the message id: a captured request
 * carried `x-conversation-request-id: 01a1862111327a898de142708d9f4f5a` alongside
 * `x-request-id: 01a1862112127fae94693612b8643bdd`.
 *
 * @returns {string} 32 hex characters in UUIDv7 shape.
 */
export function codebuddyConversationRequestId() {
  return codebuddyRequestId();
}

/**
 * `harnessMetadata` value for the `extra_vars` body field.
 *
 * The CLI stamps a JSON *string* here on every model call. A captured 2.177.0
 * request carried exactly:
 * `{"schemaVersion":1,"harnessVersion":"2.177.0","stepIndex":0,"contextWindowId":"01a18621-1213-7a39-97ad-580ba22bca96","agent":{"depth":0}}`
 * DurinDoor has no turn/step pipeline, so `stepIndex` is always 0 and `depth` is
 * always 0 (top-level agent, not a subagent). `contextWindowId` reuses the
 * conversation id, which is per-session exactly as the CLI's context window is;
 * the CLI mints it separately (the captured value differed from both the session
 * id and the conversation request id) but nothing upstream was observed to
 * correlate the two, so one id keeps the gateway's state simpler.
 *
 * @param {string} conversationId - Dashed conversation id.
 * @returns {string} JSON-encoded harness metadata.
 */
export function codebuddyHarnessMetadata(conversationId) {
  return JSON.stringify({
    schemaVersion: 1,
    harnessVersion: codebuddyCliVersion(),
    stepIndex: 0,
    contextWindowId: isString(conversationId) ? conversationId : "",
    agent: { depth: 0 },
  });
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
    return claims && typeof claims === "object" ? claims : null;
  } catch {
    return null;
  }
}

/**
 * Identity headers the CLI derives from its authenticated session.
 *
 * A captured 2.177.0 request made with a real account token carried
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
