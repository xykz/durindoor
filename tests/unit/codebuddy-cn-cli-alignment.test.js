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
  codebuddyCliVersion,
  codebuddyConversationId,
  codebuddyIdentityHeaders,
  codebuddyRequestId,
  codebuddyTraceContext,
  codebuddyTraceHeaders,
  codebuddyUserAgent,
} from "../../open-sse/providers/codebuddyCli.js";

// 2.138.0 mints plain random UUIDv4s: no embedded timestamp, nothing to forge.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_ID_RE = /^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/;
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const UA_RE = /^CLI\/(\d+\.\d+\.\d+) CodeBuddy\/(\d+\.\d+\.\d+)$/;

const ENV_KEYS = [
  "CODEBUDDY_CLI_VERSION",
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

  it("mints dash-stripped UUIDv4 request ids", () => {
    const id = codebuddyRequestId();
    expect(id).toMatch(REQUEST_ID_RE);
    expect(codebuddyRequestId()).not.toBe(id);
  });

  it("passes any dashed UUID session id through and reshapes anything else", () => {
    // The CLI sends whatever session id it is handed, verbatim
    // (a `--session-id arbitrary_session-42` run went upstream unchanged), so a
    // UUID is passed through as-is.
    const v4 = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    expect(codebuddyConversationId(v4)).toBe(v4);

    // A non-UUID seed is hashed into a stable dashed UUIDv4: no timestamp, so
    // the id never decodes to a bogus year the way a UUIDv7 hash would.
    const hashed = codebuddyConversationId("session-abc");
    expect(hashed).toMatch(UUID_V4_RE);
    expect(codebuddyConversationId("session-abc")).toBe(hashed);
    expect(codebuddyConversationId("session-xyz")).not.toBe(hashed);
    expect(codebuddyConversationId()).toBe(codebuddyConversationId(""));
  });

  it("seeds the trace context with a fresh random trace and span pair", () => {
    const ctx = codebuddyTraceContext();
    expect(ctx.traceId).toMatch(TRACE_ID_RE);
    expect(ctx.spanId).toMatch(SPAN_ID_RE);
    expect(ctx.parentSpanId).toMatch(SPAN_ID_RE);
    expect(ctx.sampled).toBe(true);
    expect(codebuddyTraceContext().traceId).not.toBe(ctx.traceId);
  });

  it("derives all seven trace headers from that one span context", () => {
    const ctx = { traceId: "a".repeat(32), spanId: "b".repeat(16), parentSpanId: "c".repeat(16), sampled: true };
    expect(codebuddyTraceHeaders(ctx)).toEqual({
      traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
      b3: `${"a".repeat(32)}-${"b".repeat(16)}-1-${"c".repeat(16)}`,
      "X-B3-TraceId": "a".repeat(32),
      "X-B3-SpanId": "b".repeat(16),
      "X-B3-ParentSpanId": "c".repeat(16),
      "X-B3-Sampled": "1",
      "X-Trace-ID": "a".repeat(32),
    });
  });

  it("omits the B3 parent segment when there is no parent span", () => {
    const headers = codebuddyTraceHeaders({
      traceId: "a".repeat(32), spanId: "b".repeat(16), parentSpanId: "", sampled: true,
    });
    expect(headers.b3).toBe(`${"a".repeat(32)}-${"b".repeat(16)}-1`);
    expect(headers["X-B3-ParentSpanId"]).toBeUndefined();
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

    expect(headers["X-Conversation-ID"]).toMatch(UUID_V4_RE);
    // One value, four names: the CLI seeds its model-call span's trace id from
    // the conversation request id and reuses it for the B3 and X-Trace-ID headers.
    expect(headers["X-Conversation-Request-ID"]).toMatch(TRACE_ID_RE);
    expect(headers["X-Root-Request-ID"]).toBe(headers["X-Conversation-Request-ID"]);
    expect(headers["X-B3-TraceId"]).toBe(headers["X-Conversation-Request-ID"]);
    expect(headers["X-Trace-ID"]).toBe(headers["X-Conversation-Request-ID"]);
    expect(headers["X-Conversation-Message-ID"]).toMatch(REQUEST_ID_RE);
    expect(headers["X-Request-ID"]).toBe(headers["X-Conversation-Message-ID"]);
    expect(headers["X-Conversation-Request-ID"]).not.toBe(headers["X-Request-ID"]);
    expect(headers["X-Agent-Intent"]).toBe("craft");
    // 2.138.0 has no X-Agent-Runtime — it first ships in 2.172.1.
    expect(headers["X-Agent-Runtime"]).toBeUndefined();
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

  it("stamps the seven trace headers the CLI's model-call span produces", () => {
    const headers = makeExec().buildHeaders(CREDENTIALS, true, CONTEXT);
    const traceId = headers["X-B3-TraceId"];
    const spanId = headers["X-B3-SpanId"];
    const parentSpanId = headers["X-B3-ParentSpanId"];

    expect(traceId).toMatch(TRACE_ID_RE);
    expect(spanId).toMatch(SPAN_ID_RE);
    expect(parentSpanId).toMatch(SPAN_ID_RE);
    expect(headers["b3"]).toBe(`${traceId}-${spanId}-1-${parentSpanId}`);
    expect(headers["traceparent"]).toBe(`00-${traceId}-${spanId}-01`);
    expect(headers["X-B3-Sampled"]).toBe("1");
    // The prior session's trace must not leak into this one.
    expect(spanId).not.toBe(parentSpanId);
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

describe("CodeBuddyExecutor keeps the 2.138.0 body shape", () => {
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

  // 2.138.0 predates these body fields — both were first captured in 2.172.1.
  // Synthesizing them would be a newer-CLI tell, so they must stay absent unless
  // the client sent them.
  it.each(["cache_retention", "extra_vars"])("does not add %s", (field) => {
    const out = makeExec().transformRequest("glm-5.2", plainBody(), true, CREDENTIALS, CONTEXT);
    expect(out[field]).toBeUndefined();
  });

  // verbosity is the odd one out: captured 2.138.0 bodies carry it alongside the
  // reasoning trio, and it only disappears in 2.164.0. So it must NOT be in the
  // never-add list above — it travels with reasoning_summary.
  it("carries verbosity beside the reasoning trio, like a captured 2.138.0", () => {
    const body = { ...plainBody(), reasoning_effort: "high" };
    const out = makeExec().transformRequest("glm-5.2", body, true, CREDENTIALS, CONTEXT);
    expect(out.verbosity).toBe("high");
    expect(out.reasoning_effort).toBe("high");
    expect(out.reasoning_summary).toBe("auto");
  });

  it("does not send verbosity on a request that asked for no reasoning", () => {
    const out = makeExec().transformRequest("glm-5.2", plainBody(), true, CREDENTIALS, CONTEXT);
    expect(out.verbosity).toBeUndefined();
  });

  it("leaves a client-supplied verbosity alone", () => {
    const body = { ...plainBody(), reasoning_effort: "high", verbosity: "low" };
    const out = makeExec().transformRequest("glm-5.2", body, true, CREDENTIALS, CONTEXT);
    expect(out.verbosity).toBe("low");
  });

  it("leaves a client-supplied cache_retention alone", () => {
    const body = { ...plainBody(), cache_retention: "short" };
    const out = makeExec().transformRequest("glm-5.2", body, true, CREDENTIALS, CONTEXT);
    expect(out.cache_retention).toBe("short");
  });
});

describe("CodeBuddyExecutor mirrors the CLI's reasoning trio", () => {
  it("adds reasoning_summary when the client asks for reasoning", () => {
    const body = { ...plainBody(), reasoning_effort: "low" };
    const out = makeExec().transformRequest("glm-5.2", body, true, CREDENTIALS, CONTEXT);
    expect(out.reasoning_effort).toBe("low");
    expect(out.reasoning_summary).toBe("auto");
  });

  it("stays silent when the client asked for no reasoning (#2071)", () => {
    const out = makeExec().transformRequest("glm-5.2", plainBody(), true, CREDENTIALS, CONTEXT);
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.reasoning_summary).toBeUndefined();
  });

  it("drops the gateway's none/off effort levels", () => {
    for (const level of ["none", "off"]) {
      const out = makeExec().transformRequest("glm-5.2", { ...plainBody(), reasoning_effort: level }, true, CREDENTIALS, CONTEXT);
      expect(out.reasoning_effort).toBeUndefined();
      expect(out.reasoning_summary).toBeUndefined();
    }
  });
});

describe("CodeBuddyExecutor CLI-alignment kill switch", () => {
  it("drops the mirrored headers and body additions when disabled", () => {
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
      "X-Agent-Type",
      "X-Agent-Purpose",
      "X-Private-Data",
      "X-Root-Request-ID",
      "traceparent",
      "b3",
      "X-B3-TraceId",
      "X-B3-ParentSpanId",
      "X-B3-SpanId",
      "X-B3-Sampled",
      "X-Trace-ID",
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

    const out = exec.transformRequest(
      "glm-5.2",
      { ...plainBody(), reasoning_effort: "high" },
      true,
      CREDENTIALS,
      CONTEXT
    );
    expect(out.cache_retention).toBeUndefined();
    expect(out.extra_vars).toBeUndefined();
    // verbosity rides with the reasoning trio, which the kill switch leaves intact.
    expect(out.verbosity).toBe("high");
  });

  it("keeps the pre-alignment behaviour of stream forcing and reasoning opt-in", () => {
    process.env.CODEBUDDY_CLI_ALIGNMENT = "off";
    const out = makeExec().transformRequest("glm-5.2", plainBody(), false, CREDENTIALS, CONTEXT);
    expect(out.stream).toBe(true);
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.reasoning_summary).toBeUndefined();
  });
});
