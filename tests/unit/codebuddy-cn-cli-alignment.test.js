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
  codebuddyRequestId,
  codebuddyUserAgent,
} from "../../open-sse/providers/codebuddyCli.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST_ID_RE = /^[0-9a-f]{32}$/;
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

  it("mints dash-stripped 32-hex request ids", () => {
    const id = codebuddyRequestId();
    expect(id).toMatch(REQUEST_ID_RE);
    expect(codebuddyRequestId()).not.toBe(id);
  });

  it("passes a UUID through and hashes any other seed into a stable UUID", () => {
    const uuid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    expect(codebuddyConversationId(uuid)).toBe(uuid);

    const hashed = codebuddyConversationId("session-abc");
    expect(hashed).toMatch(UUID_RE);
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

  it("does not send the daemon-only x-codebuddy-request header on chat", () => {
    expect(provider.headers["x-codebuddy-request"]).toBeUndefined();
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

    expect(headers["X-Conversation-ID"]).toMatch(UUID_RE);
    expect(headers["X-Conversation-Request-ID"]).toMatch(REQUEST_ID_RE);
    expect(headers["X-Conversation-Message-ID"]).toBe(headers["X-Conversation-Request-ID"]);
    expect(headers["X-Request-ID"]).toBe(headers["X-Conversation-Request-ID"]);
    expect(headers["X-Agent-Intent"]).toBe("craft");
    expect(headers["X-Agent-Runtime"]).toBe("other");
    expect(headers["X-Agent-Type"]).toBe("main");
    expect(headers["X-IDE-Version"]).toBe(codebuddyCliVersion());
    expect(headers["User-Agent"]).toBe(codebuddyUserAgent());
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
    ]) {
      expect(headers[key]).toBeUndefined();
    }

    const out = exec.transformRequest("glm-5.2", plainBody(), true, CREDENTIALS, CONTEXT);
    expect(out.cache_retention).toBeUndefined();
  });

  it("keeps the pre-alignment behaviour of stream forcing and reasoning opt-in", () => {
    process.env.CODEBUDDY_CLI_ALIGNMENT = "off";
    const out = makeExec().transformRequest("glm-5.2", plainBody(), false, CREDENTIALS, CONTEXT);
    expect(out.stream).toBe(true);
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.reasoning_summary).toBeUndefined();
  });
});
