// codebuddy-cn ↔ official CLI alignment: fingerprint source and registry wiring.
//
// These cases cover the shared version/UA/identity derivations and the registry
// values built from them, plus the executor's CLI-mirroring behaviour.
//
// See docs/providers/codebuddy-cn.md for the full alignment contract, including
// the headers DurinDoor deliberately does NOT mirror.

import { describe, it, expect, afterEach } from "vitest";
import { CodeBuddyExecutor } from "../../open-sse/executors/codebuddy-cn.js";
import { PROVIDERS, PROVIDER_OAUTH } from "../../open-sse/providers/index.js";
import {
  CODEBUDDY_CLI_VERSION,
  codebuddyCacheRetention,
  codebuddyCliVersion,
  codebuddyConversationId,
  codebuddyIdentityHeaders,
  codebuddyRequestId,
  codebuddyUserAgent,
} from "../../open-sse/providers/codebuddyCli.js";

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_RE = /^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/;
const UA_RE = /^CLI\/(\d+\.\d+\.\d+) CodeBuddy\/(\d+\.\d+\.\d+)$/;

const ENV_KEYS = [
  "CODEBUDDY_CLI_VERSION",
  "CODEBUDDY_DISABLE_PROMPT_CACHING_1H",
  "CODEBUDDY_CLI_ALIGNMENT",
];

const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function makeExec() {
  return new CodeBuddyExecutor();
}

const CREDENTIALS = { accessToken: "test-token", connectionId: "conn-abc" };
const CONTEXT = { sessionId: "session-abc", catalogModel: "glm-5.2", modelCapabilities: {} };

function plainBody() {
  return { messages: [{ role: "user", content: "hi" }] };
}

// Builds an unsigned JWT. The CLI decodes these claims without verifying the
// signature, so a synthetic payload reproduces what a real login produces.
function jwt(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

describe("CodeBuddy CN CLI fingerprint source", () => {
  it("pins the CLI version mirrored by this provider", () => {
    expect(CODEBUDDY_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(codebuddyCliVersion()).toBe(CODEBUDDY_CLI_VERSION);
  });

  it("builds the CLI's `CLI/<v> CodeBuddy/<v>` User-Agent", () => {
    const ua = codebuddyUserAgent();
    const match = UA_RE.exec(ua);
    expect(match).not.toBeNull();
    expect(match[1]).toBe(match[2]);
  });

  it("honours CODEBUDDY_CLI_VERSION and rejects malformed overrides", () => {
    process.env.CODEBUDDY_CLI_VERSION = "2.173.0";
    expect(codebuddyCliVersion()).toBe("2.173.0");
    expect(codebuddyUserAgent()).toBe("CLI/2.173.0 CodeBuddy/2.173.0");

    process.env.CODEBUDDY_CLI_VERSION = "not-a-version";
    expect(codebuddyCliVersion()).toBe(CODEBUDDY_CLI_VERSION);
  });

  it("derives cache_retention from the 1h-cache kill switch", () => {
    expect(codebuddyCacheRetention()).toBe("long");
    for (const truthy of ["1", "true", "YES", "on"]) {
      process.env.CODEBUDDY_DISABLE_PROMPT_CACHING_1H = truthy;
      expect(codebuddyCacheRetention()).toBe("short");
    }
    process.env.CODEBUDDY_DISABLE_PROMPT_CACHING_1H = "0";
    expect(codebuddyCacheRetention()).toBe("long");
  });

  it("mints dash-stripped UUIDv7 request ids", () => {
    const id = codebuddyRequestId();
    expect(id).toMatch(REQUEST_ID_RE);
    expect(codebuddyRequestId()).not.toBe(id);
  });

  it("passes a UUIDv7 session id through and reshapes anything else", () => {
    // The CLI's own session id is a dashed UUIDv7; it is sent verbatim.
    const v7 = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    expect(codebuddyConversationId(v7)).toBe(v7);

    // A UUIDv4 (what DurinDoor used to send) is not the CLI's shape, so it is
    // re-shaped rather than passed through.
    const v4 = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    expect(codebuddyConversationId(v4)).toMatch(UUID_V7_RE);
    expect(codebuddyConversationId(v4)).not.toBe(v4);

    const hashed = codebuddyConversationId("session-abc");
    expect(hashed).toMatch(UUID_V7_RE);
    expect(codebuddyConversationId("session-abc")).toBe(hashed);
    expect(codebuddyConversationId("session-xyz")).not.toBe(hashed);
    expect(codebuddyConversationId()).toBe(codebuddyConversationId(""));
  });
});

describe("CodeBuddy CN registry mirrors the CLI fingerprint", () => {
  const provider = PROVIDERS["codebuddy-cn"];
  // The build pipeline strips `oauth` off PROVIDERS and re-exports it as
  // PROVIDER_OAUTH[id] (open-sse/providers/index.js:47), which is what
  // src/lib/oauth/constants/oauth.js consumes as CODEBUDDY_CONFIG.
  const oauthConfig = PROVIDER_OAUTH["codebuddy-cn"];

  it("uses the derived User-Agent on the chat transport and the OAuth flow", () => {
    expect(provider.headers["User-Agent"]).toBe(codebuddyUserAgent());
    expect(oauthConfig.userAgent).toBe(codebuddyUserAgent());
  });

  it("exposes the pinned CLI version as transport metadata", () => {
    expect(provider.cliVersion).toBe(CODEBUDDY_CLI_VERSION);
  });

  it("keeps the two headers a source read wrongly suggests are daemon-only", () => {
    // Both appear only at daemon call sites when you read the bundle, but a
    // captured 2.177.0 chat request carries them. The capture wins.
    expect(provider.headers["x-codebuddy-request"]).toBe("1");
    expect(provider.headers["x-requested-with"]).toBe("XMLHttpRequest");
  });

  it("keeps the CLI's product/IDE headers", () => {
    expect(provider.headers["X-Product"]).toBe("SaaS");
    expect(provider.headers["X-IDE-Type"]).toBe("CLI");
    expect(provider.headers["X-IDE-Name"]).toBe("CLI");
  });
});

describe("CodeBuddyExecutor mirrors CLI conversation headers", () => {
  it("stamps the CLI's per-request identity headers", () => {
    const headers = makeExec().buildHeaders(CREDENTIALS, true, CONTEXT);

    expect(headers["X-Conversation-ID"]).toMatch(UUID_V7_RE);
    // A captured request carried the same value on both of these, and it differs
    // from the message id: it is the per-prompt id, minted once per turn.
    expect(headers["X-Conversation-Request-ID"]).toMatch(REQUEST_ID_RE);
    expect(headers["X-Root-Request-ID"]).toBe(headers["X-Conversation-Request-ID"]);
    expect(headers["X-Conversation-Message-ID"]).toMatch(REQUEST_ID_RE);
    expect(headers["X-Request-ID"]).toBe(headers["X-Conversation-Message-ID"]);
    expect(headers["X-Conversation-Request-ID"]).not.toBe(headers["X-Request-ID"]);
    expect(headers["X-Agent-Intent"]).toBe("craft");
    expect(headers["X-Agent-Runtime"]).toBe("other");
    expect(headers["X-Agent-Type"]).toBe("main");
    expect(headers["X-Agent-Purpose"]).toBe("conversation");
    expect(headers["X-Private-Data"]).toBe("false");
    expect(headers["X-IDE-Version"]).toBe(codebuddyCliVersion());
    expect(headers["User-Agent"]).toBe(codebuddyUserAgent());
  });

  it("mirrors the OpenAI SDK's Stainless headers and json Accept", () => {
    const headers = makeExec().buildHeaders(CREDENTIALS, true, CONTEXT);

    expect(headers["Accept"]).toBe("application/json");
    expect(headers["X-Stainless-Lang"]).toBe("js");
    expect(headers["X-Stainless-Package-Version"]).toBe("6.25.0");
    expect(headers["X-Stainless-Runtime"]).toBe("node");
    expect(headers["X-Stainless-Runtime-Version"]).toBe(process.version);
    expect(headers["X-Stainless-Retry-Count"]).toBe("0");
    // No X-Stainless-Timeout: a captured request has none, even though the SDK
    // emits one when the client sets a timeout.
    expect(headers["X-Stainless-Timeout"]).toBeUndefined();
    expect(headers["X-Stainless-OS"]).toMatch(/^[A-Za-z]+$/);
    expect(headers["X-Stainless-Arch"]).toMatch(/^[a-z0-9]+$/);
  });

  it("sends Accept: application/json even without a request context", () => {
    // The CLI signals streaming through the body, not the Accept header, so the
    // json Accept must not depend on the alignment headers being applied.
    expect(makeExec().buildHeaders(CREDENTIALS, true, null)["Accept"]).toBe("application/json");
  });

  it("restores the streaming Accept when alignment is off", () => {
    process.env.CODEBUDDY_CLI_ALIGNMENT = "off";
    expect(makeExec().buildHeaders(CREDENTIALS, true, CONTEXT)["Accept"]).toBe("text/event-stream");
  });

  it("anchors X-Conversation-ID on the gateway session and keeps it stable", () => {
    const exec = makeExec();
    const first = exec.buildHeaders(CREDENTIALS, true, CONTEXT);
    const second = exec.buildHeaders(CREDENTIALS, true, CONTEXT);

    expect(first["X-Conversation-ID"]).toBe(second["X-Conversation-ID"]);
    expect(first["X-Request-ID"]).not.toBe(second["X-Request-ID"]);

    const other = exec.buildHeaders(CREDENTIALS, true, { ...CONTEXT, sessionId: "session-xyz" });
    expect(other["X-Conversation-ID"]).not.toBe(first["X-Conversation-ID"]);
  });

  it("falls back to the connection id when the request carries no session", () => {
    const headers = makeExec().buildHeaders(CREDENTIALS, true, { catalogModel: "glm-5.2" });
    expect(headers["X-Conversation-ID"]).toBe(codebuddyConversationId(CREDENTIALS.connectionId));
  });

  it("leaves headers untouched when there is nothing to anchor on", () => {
    const headers = makeExec().buildHeaders({ accessToken: "t" }, true, null);
    expect(headers["X-Conversation-ID"]).toBeUndefined();
    expect(headers["X-Request-ID"]).toBeUndefined();
  });

  it("does not leak the mirrored headers onto the OAuth credential shape twice", () => {
    const headers = makeExec().buildHeaders(CREDENTIALS, true, CONTEXT);
    const keys = Object.keys(headers).filter((key) => key.toLowerCase() === "x-conversation-id");
    expect(keys).toHaveLength(1);
  });
});

describe("CodeBuddy CN identity headers derive from the account token", () => {
  // A captured 2.177.0 request made with a real account token carried these two
  // headers derived from the token claims; the same request without a token
  // carried neither and degraded X-User-Id to "anonymous".
  const CONSUMER_TOKEN = jwt({
    sub: "2a2c9009-18cc-44bb-b8d5-2cdeacefea12",
    preferred_username: "13360580715",
    iss: "https://www.codebuddy.cn/auth/realms/copilot",
    enterprise_id: "",
  });
  const ENTERPRISE_TOKEN = jwt({
    sub: "9f1c2d3e-4a5b-6c7d-8e9f-001122334455",
    iss: "https://www.codebuddy.cn/auth/realms/sso-987654321",
  });

  it("derives X-User-Id from the token subject and X-Domain from the issuer host", () => {
    expect(codebuddyIdentityHeaders(CONSUMER_TOKEN)).toEqual({
      "X-User-Id": "2a2c9009-18cc-44bb-b8d5-2cdeacefea12",
      "X-Domain": "www.codebuddy.cn",
    });
  });

  it("treats an sso- issuer as an enterprise account and flips the private-data flag", () => {
    expect(codebuddyIdentityHeaders(ENTERPRISE_TOKEN)).toEqual({
      "X-User-Id": "9f1c2d3e-4a5b-6c7d-8e9f-001122334455",
      "X-Domain": "www.codebuddy.cn",
      "X-Enterprise-Id": "987654321",
      "X-Tenant-Id": "987654321",
      "X-Private-Data": "true",
    });
  });

  it("emits nothing for an unreadable token rather than throwing", () => {
    expect(codebuddyIdentityHeaders("not-a-jwt")).toEqual({});
    expect(codebuddyIdentityHeaders(undefined)).toEqual({});
    expect(codebuddyIdentityHeaders("")).toEqual({});
  });

  it("never emits the identity headers a stored OAuth token cannot populate", () => {
    const headers = codebuddyIdentityHeaders(ENTERPRISE_TOKEN);
    for (const key of ["X-Userinfo", "X-Auth-Method", "X-Id-Source", "X-Department-Info"]) {
      expect(headers[key]).toBeUndefined();
    }
  });

  it("falls back to the CLI's pseudonymous id for an opaque API key", () => {
    // A captured API-key run carried X-User-Id: anonymous_<last 8> and no X-Domain.
    expect(codebuddyIdentityHeaders(undefined, "sk-test-apikey-12345678")).toEqual({
      "X-User-Id": "anonymous_12345678",
    });
    const headers = makeExec().buildHeaders(
      { apiKey: "sk-test-apikey-12345678", connectionId: "conn-abc" },
      true,
      CONTEXT
    );
    expect(headers["X-User-Id"]).toBe("anonymous_12345678");
    expect(headers["X-Domain"]).toBeUndefined();
  });

  it("sends them on the wire for a consumer account", () => {
    const headers = makeExec().buildHeaders(
      { accessToken: CONSUMER_TOKEN, connectionId: "conn-abc" },
      true,
      CONTEXT
    );
    expect(headers["X-User-Id"]).toBe("2a2c9009-18cc-44bb-b8d5-2cdeacefea12");
    expect(headers["X-Domain"]).toBe("www.codebuddy.cn");
    expect(headers["X-Private-Data"]).toBe("false");
    expect(headers["X-Enterprise-Id"]).toBeUndefined();
  });

  it("keeps the non-enterprise private-data default when the token is opaque", () => {
    const headers = makeExec().buildHeaders(CREDENTIALS, true, CONTEXT);
    expect(headers["X-Private-Data"]).toBe("false");
    expect(headers["X-User-Id"]).toBeUndefined();
  });
});

describe("CodeBuddyExecutor mirrors CLI cache_retention", () => {
  it("stamps the CLI default on every chat request", () => {
    const out = makeExec().transformRequest("glm-5.2", plainBody(), true, CREDENTIALS, CONTEXT);
    expect(out.cache_retention).toBe("long");
  });

  it("honours CODEBUDDY_DISABLE_PROMPT_CACHING_1H", () => {
    process.env.CODEBUDDY_DISABLE_PROMPT_CACHING_1H = "1";
    const out = makeExec().transformRequest("glm-5.2", plainBody(), true, CREDENTIALS, CONTEXT);
    expect(out.cache_retention).toBe("short");
  });

  it("never overrides an explicit client value", () => {
    const body = { ...plainBody(), cache_retention: "short" };
    const out = makeExec().transformRequest("glm-5.2", body, true, CREDENTIALS, CONTEXT);
    expect(out.cache_retention).toBe("short");
  });

  it("keeps forcing stream (CodeBuddy rejects non-stream with code 11101)", () => {
    const out = makeExec().transformRequest("glm-5.2", plainBody(), false, CREDENTIALS, CONTEXT);
    expect(out.stream).toBe(true);
  });

  it("restores stream_options when the caller asked for a non-stream request", () => {
    // The superclass's `stream===false` branch drops stream_options before the
    // forced `stream:true` lands, leaving a stream request that never reports
    // usage. The CLI always pairs the two.
    const out = makeExec().transformRequest("glm-5.2", plainBody(), false, CREDENTIALS, CONTEXT);
    expect(out.stream).toBe(true);
    expect(out.stream_options).toEqual({ include_usage: true });
  });

  it("does not clobber an explicit stream_options value", () => {
    const body = { ...plainBody(), stream_options: { include_usage: false } };
    const out = makeExec().transformRequest("glm-5.2", body, true, CREDENTIALS, CONTEXT);
    expect(out.stream_options).toEqual({ include_usage: false });
  });
});

describe("CodeBuddyExecutor mirrors the CLI's verbosity beside reasoning", () => {
  it("sends text.verbosity: high when reasoning was requested", () => {
    // The CLI's model-settings interceptor sets modelSettings.text.verbosity =
    // "high" at the same moment it enables thinking.
    const body = { ...plainBody(), reasoning_effort: "high" };
    const out = makeExec().transformRequest("glm-5.2", body, true, CREDENTIALS, CONTEXT);
    expect(out.reasoning_summary).toBe("auto");
    expect(out.verbosity).toBe("high");
  });

  it("leaves verbosity unset on a plain request", () => {
    const out = makeExec().transformRequest("glm-5.2", plainBody(), true, CREDENTIALS, CONTEXT);
    expect(out.reasoning_summary).toBeUndefined();
    expect(out.verbosity).toBeUndefined();
  });

  it("never overrides a client-supplied verbosity", () => {
    const body = { ...plainBody(), reasoning_effort: "low", verbosity: "low" };
    const out = makeExec().transformRequest("glm-5.2", body, true, CREDENTIALS, CONTEXT);
    expect(out.verbosity).toBe("low");
  });
});

describe("CodeBuddyExecutor mirrors the CLI's harness metadata", () => {
  it("stamps extra_vars.harnessMetadata as the CLI's JSON string", () => {
    const out = makeExec().transformRequest("glm-5.2", plainBody(), true, CREDENTIALS, CONTEXT);
    const meta = JSON.parse(out.extra_vars.harnessMetadata);

    expect(meta.schemaVersion).toBe(1);
    expect(meta.harnessVersion).toBe(codebuddyCliVersion());
    expect(meta.stepIndex).toBe(0);
    expect(meta.agent).toEqual({ depth: 0 });
    expect(meta.contextWindowId).toMatch(UUID_V7_RE);
  });

  it("anchors contextWindowId on the same conversation id the headers carry", () => {
    const exec = makeExec();
    const headers = exec.buildHeaders(CREDENTIALS, true, CONTEXT);
    const out = exec.transformRequest("glm-5.2", plainBody(), true, CREDENTIALS, CONTEXT);

    expect(JSON.parse(out.extra_vars.harnessMetadata).contextWindowId).toBe(
      headers["X-Conversation-ID"]
    );
  });

  it("tags the turn as user-initiated, as both captured requests did", () => {
    const out = makeExec().transformRequest("glm-5.2", plainBody(), true, CREDENTIALS, CONTEXT);
    expect(out.extra_vars.initiator).toBe("user");
  });

  it("never clobbers caller-supplied extra_vars", () => {
    const body = { ...plainBody(), extra_vars: { initiator: "agent" } };
    const out = makeExec().transformRequest("glm-5.2", body, true, CREDENTIALS, CONTEXT);
    expect(out.extra_vars).toEqual({ initiator: "agent" });
  });
});

describe("CodeBuddyExecutor CLI-alignment kill switch", () => {
  it("drops the mirrored headers and cache_retention when disabled", () => {
    process.env.CODEBUDDY_CLI_ALIGNMENT = "off";
    const exec = makeExec();

    const headers = exec.buildHeaders(CREDENTIALS, true, CONTEXT);
    for (const key of [
      "X-IDE-Version",
      "X-Conversation-ID",
      "X-Conversation-Request-ID",
      "X-Conversation-Message-ID",
      "X-Request-ID",
      "X-Agent-Intent",
      "X-Agent-Runtime",
      "X-Agent-Type",
      "X-Agent-Purpose",
      "X-Private-Data",
      "X-Root-Request-ID",
      "X-Stainless-Lang",
      "X-Stainless-Package-Version",
      "X-Stainless-OS",
      "X-Stainless-Arch",
      "X-Stainless-Runtime",
      "X-Stainless-Runtime-Version",
      "X-Stainless-Retry-Count",
    ]) {
      expect(headers[key]).toBeUndefined();
    }

    const out = exec.transformRequest("glm-5.2", plainBody(), true, CREDENTIALS, CONTEXT);
    expect(out.cache_retention).toBeUndefined();
    expect(out.verbosity).toBeUndefined();
    expect(out.extra_vars).toBeUndefined();
  });

  it("keeps the pre-alignment behaviour of stream forcing and reasoning opt-in", () => {
    process.env.CODEBUDDY_CLI_ALIGNMENT = "off";
    const out = makeExec().transformRequest("glm-5.2", plainBody(), false, CREDENTIALS, CONTEXT);
    expect(out.stream).toBe(true);
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.reasoning_summary).toBeUndefined();
  });
});
