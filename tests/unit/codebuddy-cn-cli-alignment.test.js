// codebuddy-cn ↔ official CLI alignment: fingerprint source and registry wiring.
//
// These cases cover the shared version/UA/identity derivations and the registry
// values built from them. Executor-side behaviour (conversation headers,
// cache_retention, kill switch) is covered once the executor mirrors them.
//
// See docs/providers/codebuddy-cn.md for the full alignment contract, including
// the headers DurinDoor deliberately does NOT mirror.

import { describe, it, expect, afterEach } from "vitest";
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
];

const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

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
