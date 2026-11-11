import { describe, expect, it } from "vitest";
import {
  buildQuotaResourceKeys,
  evaluateProviderQuotaPreflight,
} from "../../src/shared/services/providerQuotaPreflight.js";

const NOW = Date.parse("2026-07-10T12:00:00.000Z");

function snapshot({
  connectionId = "conn-1",
  resourceKey = "scope:account",
  dimensionKey = "requests:runtime",
  state = "available",
  observedAt = NOW - 1_000,
  staleAt = NOW + 60_000,
  resetAt = null,
  cooldownUntil = null,
  sourceId = "codex:wham-usage:v1",
  sourceType = "provider_api",
} = {}) {
  return {
    identity: { connectionId, provider: "codex", accountKey: "scope:connection", resourceKey, dimensionKey },
    state,
    amounts: { limitKind: "unknown", limit: null, used: null, remaining: null, remainingRatio: null, unit: null },
    timing: {
      observedAt: new Date(observedAt).toISOString(),
      staleAt: new Date(staleAt).toISOString(),
      resetAt: resetAt ? new Date(resetAt).toISOString() : null,
      cooldownUntil: cooldownUntil ? new Date(cooldownUntil).toISOString() : null,
    },
    provenance: { sourceType, sourceId, reasonCode: null, metadata: {} },
  };
}

function evaluate(rows, options = {}) {
  return evaluateProviderQuotaPreflight(rows, {
    connectionId: "conn-1",
    provider: "codex",
    resourceKeys: ["model:gpt-5.4"],
    now: NOW,
    refreshSupported: true,
    ...options,
  });
}

describe("provider quota preflight", () => {
  it("fails open for missing, stale, unknown, and repository-error state", () => {
    expect(evaluate([])).toMatchObject({ eligible: true, skip: false, reason: "missing", freshness: "missing", shouldRefresh: true });
    expect(evaluate([snapshot({ staleAt: NOW })])).toMatchObject({ eligible: true, skip: false, reason: "stale", freshness: "stale", shouldRefresh: true });
    expect(evaluate([snapshot({ state: "unknown" })])).toMatchObject({ eligible: true, skip: false, reason: "unknown", freshness: "fresh", shouldRefresh: true });
    expect(evaluate([], { trackerError: true })).toMatchObject({ eligible: true, skip: false, reason: "tracker_error", shouldRefresh: true });
  });

  it("publishes aged-out windows separately so ordering survives a cold pool", () => {
    // `quotaProfile` must stay null for stale rows (routing floors read its
    // ratios and a stale low ratio would trip the local 503 floor), so the
    // aged-out windows ride on their own field for bonus-first to order by.
    const staleAt = NOW - 1_000;
    const freshAt = NOW + 60_000;
    const codebuddy = {
      provider: "codebuddy-cn",
      resourceKeys: [],
      sourceId: "codebuddy-cn:billing-meter:v1",
    };
    const pack = (overrides) => {
      const row = snapshot({
        sourceId: codebuddy.sourceId,
        resourceKey: "package:bonus-1",
        dimensionKey: "credits:capacity",
        state: "available",
        resetAt: NOW + 86_400_000,
        ...overrides,
      });
      row.amounts = { limitKind: "absolute", limit: 100, used: 0, remaining: 60, remainingRatio: 0.6, unit: "credits" };
      return row;
    };
    const decision = evaluate([pack({ observedAt: NOW - 3_600_000, staleAt })], codebuddy);
    expect(decision.quotaProfile).toBeNull();
    expect(decision.staleRoutingWindows).toEqual([
      {
        resourceKey: "package:bonus-1",
        dimensionKey: "credits:capacity",
        unit: "credits",
        ratio: 0.6,
        resetAt: new Date(NOW + 86_400_000).toISOString(),
        recurring: null,
        remaining: 60,
      },
    ]);
    // A fresh observation stays on the profile and is not duplicated here.
    const fresh = evaluate([pack({ observedAt: NOW - 1_000, staleAt: freshAt })], codebuddy);
    expect(fresh.quotaProfile?.routingWindows).toHaveLength(1);
    expect(fresh.staleRoutingWindows).toEqual([]);
  });

  it("accepts fresh available and low observations", () => {
    expect(evaluate([snapshot()])).toMatchObject({ eligible: true, skip: false, reason: "available", freshness: "fresh" });
    expect(evaluate([snapshot({ state: "low" })])).toMatchObject({ eligible: true, skip: false, reason: "low", freshness: "fresh" });
  });

  it("skips exact-model and account-wide blockers but ignores unrelated models", () => {
    const reset = NOW + 30_000;
    const exact = snapshot({ resourceKey: "model:gpt-5.4", state: "exhausted", resetAt: reset });
    expect(evaluate([exact])).toMatchObject({ skip: true, reason: "exhausted", retryAt: new Date(reset).toISOString() });
    expect(evaluate([snapshot({ state: "cooldown", cooldownUntil: reset })])).toMatchObject({ skip: true, reason: "cooldown" });
    expect(evaluate([snapshot({ resourceKey: "model:gpt-5.5", state: "exhausted", resetAt: reset })]))
      .toMatchObject({ eligible: true, skip: false, reason: "missing" });
  });

  it("treats reset, cooldown, and stale boundaries as expired", () => {
    expect(evaluate([snapshot({ state: "cooldown", staleAt: NOW, cooldownUntil: NOW })]))
      .toMatchObject({ eligible: true, skip: false, reason: "stale" });
    expect(evaluate([snapshot({ state: "exhausted", staleAt: NOW, resetAt: NOW })]))
      .toMatchObject({ eligible: true, skip: false, reason: "stale" });
  });

  it("requires every applicable blocker deadline and uses the latest one", () => {
    const first = NOW + 20_000;
    const second = NOW + 40_000;
    const decision = evaluate([
      snapshot({ state: "cooldown", cooldownUntil: first, dimensionKey: "requests:minute" }),
      snapshot({ state: "exhausted", resetAt: second, dimensionKey: "requests:week" }),
    ]);
    expect(decision).toMatchObject({ skip: true, retryAt: new Date(second).toISOString() });

    const unknownDeadline = evaluate([
      snapshot({ state: "exhausted", resetAt: null, staleAt: NOW + 60_000 }),
      snapshot({ state: "cooldown", cooldownUntil: first, dimensionKey: "requests:minute" }),
    ]);
    expect(unknownDeadline.retryAt).toBeNull();
  });

  it("keeps a fresh runtime blocker authoritative beside available provider data", () => {
    const reset = NOW + 30_000;
    const decision = evaluate([
      snapshot({ state: "available", sourceId: "codex:wham-usage:v1" }),
      snapshot({ state: "cooldown", cooldownUntil: reset, sourceId: "codex:runtime:v1", sourceType: "response_headers" }),
    ]);
    expect(decision).toMatchObject({ skip: true, reason: "cooldown", sourceId: "codex:runtime:v1" });
  });

  it("does not globally block monitoring when only some known model scopes are exhausted", () => {
    const reset = NOW + 30_000;
    const rows = [
      snapshot({ resourceKey: "model:a", state: "exhausted", resetAt: reset }),
      snapshot({ resourceKey: "model:b", state: "available" }),
    ];
    expect(evaluate(rows, { resourceKeys: [], connectionWide: true })).toMatchObject({ eligible: true, skip: false });
    rows[1] = snapshot({ resourceKey: "model:b", state: "unknown" });
    expect(evaluate(rows, { resourceKeys: [], connectionWide: true })).toMatchObject({ eligible: true, skip: false });
    rows[1] = snapshot({ resourceKey: "model:b", state: "cooldown", cooldownUntil: reset });
    expect(evaluate(rows, { resourceKeys: [], connectionWide: true })).toMatchObject({ eligible: true, skip: false });
  });

  it("builds only exact catalog/provider scope aliases", () => {
    expect(buildQuotaResourceKeys({
      provider: "codex",
      modelCandidates: ["gpt-5.3-codex-spark"],
      quotaFamily: "review",
    })).toEqual(expect.arrayContaining([
      "model:gpt-5.3-codex-spark",
      "model:codex-spark",
      "feature:code-review",
    ]));
    expect(buildQuotaResourceKeys({
      provider: "codex",
      modelCandidates: ["evil-reviewish-model"],
      quotaFamily: null,
    })).not.toContain("feature:code-review");
  });
});
