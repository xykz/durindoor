/**
 * Unit tests for the CodeBuddy CN (Tencent) OAuth token refresh.
 *
 * The refresh path must mirror `refreshSession` in the official
 * `@tencent-ai/codebuddy-code` CLI, because the CN SaaS endpoint authenticates
 * the refresh with a header, not a form body:
 *   POST /v2/plugin/auth/token/refresh
 *   X-Refresh-Token: <refresh token>
 *   X-Auth-Refresh-Source: plugin
 *   X-Domain: <endpoint host>
 *   body: {}
 * and no Authorization header. The response envelope is { code: 0, data: {...} }.
 *
 * A 401/403 there means the grant itself is dead (the official client raises
 * UnauthorizedError), so it must surface as the permanent
 * `unrecoverable_refresh_error` signal instead of a silent `null` — otherwise
 * the gateway keeps a dead connection and every call fails with an opaque 401.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { proxyAwareFetchMock } = vi.hoisted(() => ({
  proxyAwareFetchMock: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: proxyAwareFetchMock,
}));

import { PROVIDER_OAUTH } from "../../open-sse/config/providers.js";
import { refreshCodebuddyToken } from "../../open-sse/services/tokenRefresh/providers.js";
import { isUnrecoverableRefreshError } from "../../open-sse/services/tokenRefresh.js";
import { __clearRefreshDedupCacheForTesting } from "../../open-sse/services/tokenRefresh/dedup.js";

const CODEBUDDY_OAUTH = PROVIDER_OAUTH["codebuddy-cn"];

function createLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function queueJsonResponse(payload, status = 200) {
  proxyAwareFetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function queueRawResponse(text, status = 200) {
  proxyAwareFetchMock.mockResolvedValueOnce(
    new Response(text, {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function lastRequest() {
  const call = proxyAwareFetchMock.mock.calls.at(-1);
  return { url: call?.[0], init: call?.[1], proxyOptions: call?.[2] };
}

describe("refreshCodebuddyToken (CN)", () => {
  beforeEach(() => {
    // dedupRefresh caches successful results per refresh token + proxy route,
    // so a stale entry would short-circuit the next case's fetch stub.
    __clearRefreshDedupCacheForTesting();
    proxyAwareFetchMock.mockReset();
  });

  afterEach(() => {
    __clearRefreshDedupCacheForTesting();
  });

  it("posts the refresh token as a header with the official plugin headers", async () => {
    queueJsonResponse({
      code: 0,
      data: {
        accessToken: "cbcn-new-access",
        refreshToken: "cbcn-rotated-refresh",
        expiresIn: 3600,
      },
    });
    const log = createLog();
    const proxyOptions = { proxyUrl: "http://proxy.internal:3128" };

    const result = await refreshCodebuddyToken("cbcn-header-case", log, proxyOptions);

    const { url, init, proxyOptions: forwardedProxy } = lastRequest();
    expect(url).toBe(CODEBUDDY_OAUTH.refreshUrl);
    expect(url).toContain("/v2/plugin/auth/token/refresh");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Refresh-Token": "cbcn-header-case",
      "X-Auth-Refresh-Source": "plugin",
      "X-Product": "SaaS",
      "X-Domain": "copilot.tencent.com",
      "User-Agent": CODEBUDDY_OAUTH.userAgent,
    });
    // The CN refresh endpoint authenticates from X-Refresh-Token alone; sending
    // a bearer here is what the official client avoids.
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.headers.authorization).toBeUndefined();
    expect(forwardedProxy).toBe(proxyOptions);

    expect(result).toMatchObject({
      accessToken: "cbcn-new-access",
      refreshToken: "cbcn-rotated-refresh",
      expiresIn: 3600,
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it("accepts the envelope even when the server omits the code field", async () => {
    queueJsonResponse({
      data: { accessToken: "cbcn-nocode-access", expiresIn: 1200 },
    });

    const result = await refreshCodebuddyToken("cbcn-no-code-case", null);

    expect(result).toMatchObject({ accessToken: "cbcn-nocode-access", expiresIn: 1200 });
    // No rotation in the payload: the existing refresh token must be preserved.
    expect(result.refreshToken).toBe("cbcn-no-code-case");
  });

  it("accepts a top-level token object without a data envelope", async () => {
    queueJsonResponse({ accessToken: "cbcn-flat-access", expiresIn: 900 });

    const result = await refreshCodebuddyToken("cbcn-flat-case", null);

    expect(result.accessToken).toBe("cbcn-flat-access");
    expect(result.expiresIn).toBe(900);
    expect(result.refreshToken).toBe("cbcn-flat-case");
  });

  it("normalizes a string lifetime and drops trailing token whitespace", async () => {
    queueJsonResponse({
      code: 0,
      data: {
        accessToken: "  cbcn-trimmed-access  ",
        refreshToken: "  cbcn-trimmed-refresh  ",
        expiresIn: "1800",
      },
    });

    const result = await refreshCodebuddyToken("cbcn-string-expiry-case", null);

    expect(result.accessToken).toBe("cbcn-trimmed-access");
    expect(result.refreshToken).toBe("cbcn-trimmed-refresh");
    expect(result.expiresIn).toBe(1800);
  });

  it("falls back to expiresAt when no usable expiresIn is returned", async () => {
    queueJsonResponse({
      code: 0,
      data: {
        accessToken: "cbcn-expiresat-access",
        expiresAt: "2026-11-01T00:00:00.000Z",
      },
    });

    const result = await refreshCodebuddyToken("cbcn-expires-at-case", null);

    expect(result.accessToken).toBe("cbcn-expiresat-access");
    expect(result.expiresAt).toBe("2026-11-01T00:00:00.000Z");
    expect(result).not.toHaveProperty("expiresIn");
  });

  it("omits a zero lifetime instead of forwarding it as expiresIn or expiresAt", async () => {
    // The official calculateExpiresAt guards on truthiness, so expiresIn: 0
    // yields no deadline at all; providerCredentials rejects 0 as malformed.
    queueJsonResponse({
      code: 0,
      data: { accessToken: "cbcn-zero-expiry-access", expiresIn: 0 },
    });

    const result = await refreshCodebuddyToken("cbcn-zero-expiry-case", null);

    expect(result.accessToken).toBe("cbcn-zero-expiry-access");
    expect(result).not.toHaveProperty("expiresIn");
    expect(result).not.toHaveProperty("expiresAt");
  });

  it("treats 401 as a dead grant that requires re-authentication", async () => {
    queueRawResponse(
      JSON.stringify({ code: 401, msg: "refresh token expired" }),
      401
    );
    const log = createLog();

    const result = await refreshCodebuddyToken("cbcn-401-case", log);

    expect(result).toEqual({ error: "unrecoverable_refresh_error", code: "" });
    expect(isUnrecoverableRefreshError(result)).toBe(true);
    expect(log.error).toHaveBeenCalledWith(
      "TOKEN_REFRESH",
      "CodeBuddy refresh token rejected. Re-auth required.",
      expect.objectContaining({ status: 401 })
    );
  });

  it("treats 403 as a dead grant that requires re-authentication", async () => {
    queueRawResponse(JSON.stringify({ error: "forbidden" }), 403);
    const log = createLog();

    const result = await refreshCodebuddyToken("cbcn-403-case", log);

    expect(isUnrecoverableRefreshError(result)).toBe(true);
    expect(result.code).toBe("forbidden");
  });

  it("treats invalid_grant as a permanent refresh failure", async () => {
    queueRawResponse(
      JSON.stringify({ error: "invalid_grant", error_description: "token revoked" }),
      400
    );

    const result = await refreshCodebuddyToken("cbcn-invalid-grant-case", null);

    expect(isUnrecoverableRefreshError(result)).toBe(true);
    expect(result.code).toBe("invalid_grant");
  });

  it("returns null for a transient server error so the caller can retry", async () => {
    queueRawResponse(JSON.stringify({ error: "server_error" }), 500);
    const log = createLog();

    const result = await refreshCodebuddyToken("cbcn-500-case", log);

    expect(result).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      "TOKEN_REFRESH",
      "Failed to refresh CodeBuddy token",
      expect.objectContaining({ status: 500 })
    );
  });

  it("returns null when the response carries no access token", async () => {
    queueJsonResponse({ code: 0, data: { refreshToken: "cbcn-refresh-only" } });
    const log = createLog();

    const result = await refreshCodebuddyToken("cbcn-no-access-case", log);

    expect(result).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      "TOKEN_REFRESH",
      "CodeBuddy token refresh returned no access token",
      expect.objectContaining({ code: 0 })
    );
  });

  it("returns null and logs a sanitized network error when the request throws", async () => {
    proxyAwareFetchMock.mockRejectedValueOnce(
      new Error("connect ECONNREFUSED refresh_token=cbcn-live-secret-network")
    );
    const log = createLog();

    const result = await refreshCodebuddyToken("cbcn-network-case", log);

    expect(result).toBeNull();
    const logged = JSON.stringify(log.error.mock.calls);
    expect(logged).toContain("Network error refreshing CodeBuddy token");
    expect(logged).not.toContain("cbcn-live-secret-network");
  });

  it("redacts credentials echoed back by a failing upstream", async () => {
    queueRawResponse(
      JSON.stringify({
        error: "server_error",
        refresh_token: "cbcn-live-secret-echo",
      }),
      500
    );
    const log = createLog();

    await refreshCodebuddyToken("cbcn-redaction-case", log);

    const logged = JSON.stringify(log.error.mock.calls);
    expect(logged).not.toContain("cbcn-live-secret-echo");
  });

  it("derives X-Domain from the configured endpoint authority", async () => {
    queueJsonResponse({ code: 0, data: { accessToken: "cbcn-domain-access" } });
    const originalBaseUrl = CODEBUDDY_OAUTH.baseUrl;
    CODEBUDDY_OAUTH.baseUrl = "https://www.workbuddy.cn";
    try {
      await refreshCodebuddyToken("cbcn-domain-case", null);
      expect(lastRequest().init.headers["X-Domain"]).toBe("www.workbuddy.cn");
    } finally {
      CODEBUDDY_OAUTH.baseUrl = originalBaseUrl;
    }
  });

  it("does not call the network without a refresh token", async () => {
    const result = await refreshCodebuddyToken("", null);

    expect(result).toBeNull();
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
  });
});
