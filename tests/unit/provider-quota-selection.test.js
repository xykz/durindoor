import { beforeEach, describe, expect, it, vi } from "vitest";
import { quotaIdentityKey } from "../../src/shared/utils/quotaSnapshot.js";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  getQuotaFetchState: vi.fn(),
  getQuotaReservationPressure: vi.fn(),
  getConnectionTokenTotals24h: vi.fn(),
  validateApiKey: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getProviderConnectionById: mocks.getProviderConnectionById,
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
  validateApiKey: mocks.validateApiKey,
  getQuotaFetchState: mocks.getQuotaFetchState,
  getQuotaReservationPressure: mocks.getQuotaReservationPressure,
  getConnectionTokenTotals24h: mocks.getConnectionTokenTotals24h,
}));

const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

const NOW = Date.parse("2026-07-10T12:00:00.000Z");

function connection(id, priority, provider = "codex") {
  return {
    id,
    provider,
    authType: "oauth",
    accessToken: `token-${id}`,
    refreshToken: `refresh-${id}`,
    priority,
    isActive: true,
    updatedAt: new Date(NOW - 60_000).toISOString(),
  };
}

function snapshot(connectionId, {
  state,
  resourceKey = "model:gpt-5.4",
  resetAt = null,
  cooldownUntil = null,
  staleAt = NOW + 60_000,
} = {}) {
  return {
    identity: { connectionId, provider: "codex", accountKey: "scope:connection", resourceKey, dimensionKey: "requests:runtime" },
    state,
    amounts: { limitKind: "unknown", limit: null, used: null, remaining: null, remainingRatio: null, unit: null },
    timing: {
      observedAt: new Date(NOW - 1000).toISOString(),
      staleAt: new Date(staleAt).toISOString(),
      resetAt: resetAt ? new Date(resetAt).toISOString() : null,
      cooldownUntil: cooldownUntil ? new Date(cooldownUntil).toISOString() : null,
    },
    provenance: { sourceType: "response_headers", sourceId: "codex:runtime-test:v1", reasonCode: "rate_limited", metadata: {} },
  };
}

function providerRow(connectionId, remaining, {
  provider = "codex",
  resourceKey = "model:gpt-5.4",
  dimensionKey = "requests:session",
  unit = "requests",
  sourceId = "codex:wham-usage:v1",
} = {}) {
  return {
    identity: {
      connectionId,
      provider,
      accountKey: "scope:connection",
      resourceKey,
      dimensionKey,
    },
    state: remaining / 100 <= 0.2 ? "low" : "available",
    amounts: {
      limitKind: "bounded",
      limit: 100,
      used: 100 - remaining,
      remaining,
      remainingRatio: remaining / 100,
      unit,
    },
    timing: {
      observedAt: new Date(NOW - 1000).toISOString(),
      staleAt: new Date(NOW + 60_000).toISOString(),
      resetAt: new Date(NOW + 60_000).toISOString(),
      cooldownUntil: null,
    },
    provenance: { sourceType: "provider_api", sourceId, reasonCode: null, metadata: {} },
  };
}

describe("quota-aware provider selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({});
    mocks.getProxyPools.mockResolvedValue([]);
    mocks.getQuotaFetchState.mockResolvedValue(null);
    mocks.getQuotaReservationPressure.mockResolvedValue(new Map());
    mocks.getConnectionTokenTotals24h.mockResolvedValue(new Map());
    mocks.updateProviderConnection.mockImplementation(async (id, patch) => ({
      ...connection(id, id === "one" ? 1 : 2),
      ...patch,
      updatedAt: new Date(NOW).toISOString(),
    }));
  });

  it("skips a fresh exhausted account and preserves fill-first order among eligible accounts", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("one", 1), connection("two", 2), connection("three", 3)]);
    const reset = NOW + 30_000;
    const quotaSnapshotsLoader = vi.fn().mockResolvedValue([
      snapshot("one", { state: "exhausted", resetAt: reset }),
      snapshot("two", { state: "available" }),
    ]);

    const selected = await getProviderCredentials("codex", null, "gpt-5.4", {
      now: NOW,
      resourceKeys: ["model:gpt-5.4"],
      quotaSnapshotsLoader,
    });

    expect(selected.connectionId).toBe("two");
    expect(selected._quotaPreflight).toMatchObject({ eligible: true, skip: false, reason: "stale" });
    expect(quotaSnapshotsLoader).toHaveBeenCalledTimes(1);
  });

  it("keeps stale and unknown accounts eligible and marks them for shared refresh", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("one", 1)]);
    const selected = await getProviderCredentials("codex", null, "gpt-5.4", {
      now: NOW,
      resourceKeys: ["model:gpt-5.4"],
      quotaSnapshotsLoader: async () => [snapshot("one", { state: "exhausted", resetAt: NOW, staleAt: NOW })],
    });
    expect(selected.connectionId).toBe("one");
    expect(selected._quotaPreflight).toMatchObject({ reason: "stale", shouldRefresh: true });
  });

  it("returns allRateLimited without fabricating Retry-After when a blocker has no reset", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("one", 1)]);
    const result = await getProviderCredentials("codex", null, "gpt-5.4", {
      now: NOW,
      resourceKeys: ["model:gpt-5.4"],
      quotaSnapshotsLoader: async () => [snapshot("one", { state: "exhausted" })],
    });
    expect(result).toMatchObject({ allRateLimited: true, retryAfter: null, retryAfterHuman: "", lastErrorCode: 429 });
  });

  it("preserves legacy authentication status instead of rewriting it as quota", async () => {
    mocks.getProviderConnections.mockResolvedValue([{
      ...connection("one", 1),
      "modelLock_gpt-5.4": new Date(NOW + 30_000).toISOString(),
      errorCode: 401,
      lastError: "Authentication failed",
    }]);
    const result = await getProviderCredentials("codex", null, "gpt-5.4", {
      now: NOW,
      quotaSnapshotsLoader: async () => [],
    });
    expect(result).toMatchObject({ allRateLimited: true, lastErrorCode: 401, lastError: "Authentication failed", retryAfter: null });
  });

  it("keeps a legacy 429 deadline and rate-limit message", async () => {
    const retryAfter = new Date(NOW + 30_000).toISOString();
    mocks.getProviderConnections.mockResolvedValue([{
      ...connection("one", 1),
      "modelLock_gpt-5.4": retryAfter,
      errorCode: 429,
      lastError: "Rate limited",
    }]);
    const result = await getProviderCredentials("codex", null, "gpt-5.4", {
      now: NOW,
      quotaSnapshotsLoader: async () => [],
    });
    expect(result).toMatchObject({ allRateLimited: true, lastErrorCode: 429, lastError: "Rate limited", retryAfter });
  });

  it("does not expose a local legacy deadline for no-reset plan exhaustion", async () => {
    const localBreaker = new Date(NOW + 30_000).toISOString();
    mocks.getProviderConnections.mockResolvedValue([{
      ...connection("one", 1),
      "modelLock_gpt-5.4": localBreaker,
      errorCode: 429,
      lastError: "Rate limited",
    }]);
    const result = await getProviderCredentials("codex", null, "gpt-5.4", {
      now: NOW,
      resourceKeys: ["model:gpt-5.4"],
      quotaSnapshotsLoader: async () => [snapshot("one", { state: "exhausted" })],
    });
    expect(result).toMatchObject({ allRateLimited: true, lastErrorCode: 429, retryAfter: null });
  });

  it("prioritizes a legacy authentication blocker over an earlier legacy 429", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      {
        ...connection("rate", 1),
        "modelLock_gpt-5.4": new Date(NOW + 30_000).toISOString(),
        errorCode: 429,
      },
      {
        ...connection("auth", 2),
        "modelLock_gpt-5.4": new Date(NOW + 30_000).toISOString(),
        errorCode: 401,
      },
    ]);
    const result = await getProviderCredentials("codex", null, "gpt-5.4", {
      now: NOW,
      quotaSnapshotsLoader: async () => [],
    });
    expect(result).toMatchObject({
      allRateLimited: true,
      lastErrorCode: 401,
      lastError: "Authentication failed",
      retryAfter: null,
    });
  });

  it("deterministically prefers a legacy auth blocker over a mixed quota blocker", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      connection("quota", 1),
      {
        ...connection("auth", 2),
        "modelLock_gpt-5.4": new Date(NOW + 30_000).toISOString(),
        errorCode: 403,
      },
    ]);
    const result = await getProviderCredentials("codex", null, "gpt-5.4", {
      now: NOW,
      resourceKeys: ["model:gpt-5.4"],
      quotaSnapshotsLoader: async () => [snapshot("quota", { state: "exhausted", resetAt: NOW + 30_000 })],
    });
    expect(result).toMatchObject({ allRateLimited: true, lastErrorCode: 403, lastError: "Access forbidden", retryAfter: null });
  });

  it("keeps a session sticky when quota ranking would otherwise rotate the account", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { ...connection("one", 1), lastUsedAt: new Date(NOW - 1000).toISOString(), consecutiveUseCount: 1 },
      connection("two", 2),
    ]);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin", stickyRoundRobinLimit: 3 });

    // Round-robin ignores the quota rank for the first pick: "two" has never
    // been used, so LRU wins over the higher-quota "one".
    const first = await getProviderCredentials("codex", null, "gpt-5.4", {
      now: NOW,
      resourceKeys: ["model:gpt-5.4"],
      quotaSnapshotsLoader: async () => [providerRow("one", 90), providerRow("two", 10)],
      sessionId: "sess-sticky-quota",
    });
    expect(first.connectionId).toBe("two");

    // Second call reverses the quota preference and "one" is now the LRU
    // candidate; the session must stay on "two" via affinity.
    const second = await getProviderCredentials("codex", null, "gpt-5.4", {
      now: NOW,
      resourceKeys: ["model:gpt-5.4"],
      quotaSnapshotsLoader: async () => [providerRow("one", 10), providerRow("two", 90)],
      sessionId: "sess-sticky-quota",
    });
    expect(second.connectionId).toBe("two");
  });

  it("advances round-robin by lastUsedAt instead of pinning the quota-ranked top account", async () => {
    // Regression: a saturated quota pool makes every account comparable at
    // ratio 1.0, so quota ranking collapses to priority order. Under
    // round-robin a NEW session (no affinity) must advance via lastUsedAt
    // (LRU), NOT latch onto availableConnections[0].
    mocks.getProviderConnections.mockResolvedValue([
      { ...connection("one", 1), lastUsedAt: new Date(NOW - 10_000).toISOString(), consecutiveUseCount: 1 },
      { ...connection("two", 2), lastUsedAt: new Date(NOW - 1_000).toISOString(), consecutiveUseCount: 1 },
    ]);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin", stickyRoundRobinLimit: 1 });

    // Quota order prefers "two"; lastUsedAt order prefers "one".
    const selected = await getProviderCredentials("codex", null, "gpt-5.4", {
      now: NOW,
      resourceKeys: ["model:gpt-5.4"],
      quotaSnapshotsLoader: async () => [providerRow("one", 10), providerRow("two", 90)],
      sessionId: "sess-new-no-affinity",
    });

    expect(selected.connectionId).toBe("one");
  });

  // ── bonus-first (x-account-strategy) ──────────────────────────────────────
  // CodeBuddy CN bonus packs are one-shot: unused credits vanish at
  // CycleEndTime. The expiry DAY is the hard gate (accounts whose packs lapse
  // later wait), and within that day the credit totals set the rotation order:
  // the largest budget takes the first turn, then the next, wrapping around.
  // Ranking alone would pin every request on the largest account until its ~60s
  // old snapshot refreshes, which is both wasteful and a single-account rate
  // limit risk, so the order is walked round-robin instead.

  function bonusRow(connectionId, name, { remaining = 10, limit = 10, resetAt, recurring = false } = {}) {
    return {
      identity: {
        connectionId,
        provider: "codebuddy-cn",
        accountKey: "scope:connection",
        resourceKey: `package:${name}`,
        dimensionKey: "credits:capacity",
      },
      state: remaining === 0 ? "exhausted" : remaining / limit <= 0.1 ? "low" : "available",
      amounts: {
        limitKind: "bounded",
        limit,
        used: limit - remaining,
        remaining,
        remainingRatio: remaining / limit,
        unit: "credits",
      },
      timing: {
        observedAt: new Date(NOW - 1000).toISOString(),
        staleAt: new Date(NOW + 60_000).toISOString(),
        resetAt: resetAt === undefined ? null : new Date(resetAt).toISOString(),
        cooldownUntil: null,
      },
      provenance: {
        sourceType: "provider_api",
        sourceId: "codebuddy-cn:billing-meter:v1",
        reasonCode: null,
        metadata: { recurring },
      },
    };
  }

  it("bonus-first spends the soonest-expiring bonus pack regardless of recency", async () => {
    // "two" was used most recently and has fewer tokens today, so plain
    // round-robin would pick it; "one" holds a pack expiring in 1h.
    mocks.getProviderConnections.mockResolvedValue([
      { ...connection("one", 1, "codebuddy-cn"), lastUsedAt: new Date(NOW - 10_000).toISOString(), consecutiveUseCount: 3 },
      { ...connection("two", 2, "codebuddy-cn"), lastUsedAt: new Date(NOW - 1_000).toISOString(), consecutiveUseCount: 1 },
    ]);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin", stickyRoundRobinLimit: 3 });
    mocks.getConnectionTokenTotals24h.mockResolvedValue(new Map([["one", 9_000], ["two", 100]]));

    const selected = await getProviderCredentials("codebuddy-cn", null, "deepseek-v4.1-flash", {
      now: NOW,
      accountStrategy: "bonus-first",
      quotaSnapshotsLoader: async () => [
        bonusRow("one", "bonus-1", { resetAt: NOW + 3_600_000 }),
        bonusRow("two", "bonus-1", { resetAt: NOW + 30 * 86_400_000 }),
      ],
    });

    expect(selected.connectionId).toBe("one");
  });

  it("bonus-first prefers the earliest of several expiring packs", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { ...connection("one", 1, "codebuddy-cn"), lastUsedAt: new Date(NOW - 1_000).toISOString(), consecutiveUseCount: 1 },
      { ...connection("two", 2, "codebuddy-cn"), lastUsedAt: new Date(NOW - 10_000).toISOString(), consecutiveUseCount: 1 },
    ]);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin" });

    const selected = await getProviderCredentials("codebuddy-cn", null, "deepseek-v4.1-flash", {
      now: NOW,
      accountStrategy: "bonus-first",
      quotaSnapshotsLoader: async () => [
        // "one" holds a later pack plus an already-empty soon one.
        bonusRow("one", "bonus-1", { remaining: 0, resetAt: NOW + 600_000 }),
        bonusRow("one", "bonus-2", { resetAt: NOW + 7_200_000 }),
        bonusRow("two", "bonus-1", { resetAt: NOW + 1_800_000 }),
      ],
    });

    expect(selected.connectionId).toBe("two");
  });

  // ── day bucketing ─────────────────────────────────────────────────────────
  // Packs are grouped by the calendar day of their own resetAt, and one day's
  // packs form a single budget: the account is ranked by "earliest expiry day,
  // then credits still left on that day". Real CodeBuddy data routinely has
  // several packs sharing one expiry day (e.g. 100 + 100 + 5 = 205).

  const DAY_ONE = Date.parse("2026-07-11T00:00:00.000Z");
  const DAY_TWO = Date.parse("2026-07-12T00:00:00.000Z");

  it("bonus-first sums one day's packs and gives the biggest budget the first turn", async () => {
    // "one" is the most recently used and has the highest token total, so plain
    // round-robin would skip it; its three same-day packs add up to 205, which
    // leads "two" (104) and "three" (50) on the same expiry day.
    mocks.getProviderConnections.mockResolvedValue([
      { ...connection("one", 1, "codebuddy-cn"), lastUsedAt: new Date(NOW - 1_000).toISOString(), consecutiveUseCount: 1 },
      { ...connection("two", 2, "codebuddy-cn"), lastUsedAt: new Date(NOW - 20_000).toISOString(), consecutiveUseCount: 1 },
      { ...connection("three", 3, "codebuddy-cn"), lastUsedAt: new Date(NOW - 30_000).toISOString(), consecutiveUseCount: 1 },
    ]);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin" });
    mocks.getConnectionTokenTotals24h.mockResolvedValue(new Map([["one", 50_000], ["two", 100], ["three", 100]]));

    const selected = await getProviderCredentials("codebuddy-cn", null, "deepseek-v4.1-flash", {
      now: NOW,
      accountStrategy: "bonus-first",
      quotaSnapshotsLoader: async () => [
        bonusRow("one", "bonus-1", { remaining: 100, limit: 100, resetAt: DAY_ONE + 18 * 3_600_000 }),
        bonusRow("one", "bonus-2", { remaining: 100, limit: 100, resetAt: DAY_ONE + 22 * 3_600_000 }),
        bonusRow("one", "bonus-3", { remaining: 5, limit: 5, resetAt: DAY_ONE + 22 * 3_600_000 }),
        bonusRow("two", "bonus-1", { remaining: 100, limit: 100, resetAt: DAY_ONE + 19 * 3_600_000 }),
        bonusRow("two", "bonus-2", { remaining: 4, limit: 4, resetAt: DAY_ONE + 23 * 3_600_000 }),
        bonusRow("three", "bonus-1", { remaining: 50, limit: 50, resetAt: DAY_ONE + 20 * 3_600_000 }),
      ],
    });

    expect(selected.connectionId).toBe("one");
  });

  it("bonus-first rotates through the same-day cohort in credit order", async () => {
    // The user-visible contract: three separate requests must land on A, B and C
    // — one each — not all on A. A leads the day with 205 credits, B has 104 and
    // C 50, so the cycle is A→B→C→A… The turn cursor (`consecutiveUseCount`) is
    // the only state that survives between calls, hence the mutable store.
    const cursors = { one: 0, two: 0, three: 0 };
    mocks.getProviderConnections.mockImplementation(async () => [
      { ...connection("one", 1, "codebuddy-cn"), lastUsedAt: null, consecutiveUseCount: cursors.one },
      { ...connection("two", 2, "codebuddy-cn"), lastUsedAt: null, consecutiveUseCount: cursors.two },
      { ...connection("three", 3, "codebuddy-cn"), lastUsedAt: null, consecutiveUseCount: cursors.three },
    ]);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin" });
    mocks.updateProviderConnection.mockImplementation(async (id, patch) => {
      if (patch.consecutiveUseCount !== undefined) cursors[id] = patch.consecutiveUseCount;
      return { ...connection(id, 1, "codebuddy-cn"), ...patch };
    });
    const quotaSnapshotsLoader = async () => [
      bonusRow("one", "bonus-1", { remaining: 100, limit: 100, resetAt: DAY_ONE + 18 * 3_600_000 }),
      bonusRow("one", "bonus-2", { remaining: 100, limit: 100, resetAt: DAY_ONE + 22 * 3_600_000 }),
      bonusRow("one", "bonus-3", { remaining: 5, limit: 5, resetAt: DAY_ONE + 22 * 3_600_000 }),
      bonusRow("two", "bonus-1", { remaining: 100, limit: 100, resetAt: DAY_ONE + 19 * 3_600_000 }),
      bonusRow("two", "bonus-2", { remaining: 4, limit: 4, resetAt: DAY_ONE + 23 * 3_600_000 }),
      bonusRow("three", "bonus-1", { remaining: 50, limit: 50, resetAt: DAY_ONE + 20 * 3_600_000 }),
    ];

    const picks = [];
    for (let call = 0; call < 4; call += 1) {
      const selected = await getProviderCredentials("codebuddy-cn", null, "deepseek-v4.1-flash", {
        now: NOW,
        accountStrategy: "bonus-first",
        quotaSnapshotsLoader,
      });
      picks.push(selected.connectionId);
    }

    expect(picks).toEqual(["one", "two", "three", "one"]);
  });

  it("bonus-first drops a spent account out of the running day's rotation", async () => {
    // Once "three" has burned its day-one credits nothing expires there any
    // more, so the cohort shrinks to "one" and "two" and keeps rotating.
    const cursors = { one: 0, two: 0, three: 0 };
    let spent = false;
    mocks.getProviderConnections.mockImplementation(async () => [
      { ...connection("one", 1, "codebuddy-cn"), lastUsedAt: null, consecutiveUseCount: cursors.one },
      { ...connection("two", 2, "codebuddy-cn"), lastUsedAt: null, consecutiveUseCount: cursors.two },
      { ...connection("three", 3, "codebuddy-cn"), lastUsedAt: null, consecutiveUseCount: cursors.three },
    ]);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin" });
    mocks.updateProviderConnection.mockImplementation(async (id, patch) => {
      if (patch.consecutiveUseCount !== undefined) cursors[id] = patch.consecutiveUseCount;
      return { ...connection(id, 1, "codebuddy-cn"), ...patch };
    });
    const quotaSnapshotsLoader = async () => [
      bonusRow("one", "bonus-1", { remaining: 100, limit: 100, resetAt: DAY_ONE + 18 * 3_600_000 }),
      bonusRow("two", "bonus-1", { remaining: 100, limit: 100, resetAt: DAY_ONE + 19 * 3_600_000 }),
      bonusRow("three", "bonus-1", { remaining: spent ? 0 : 50, limit: 50, resetAt: DAY_ONE + 20 * 3_600_000 }),
    ];

    const picks = [];
    for (let call = 0; call < 3; call += 1) {
      const selected = await getProviderCredentials("codebuddy-cn", null, "deepseek-v4.1-flash", {
        now: NOW,
        accountStrategy: "bonus-first",
        quotaSnapshotsLoader,
      });
      picks.push(selected.connectionId);
    }
    spent = true;
    for (let call = 0; call < 2; call += 1) {
      const selected = await getProviderCredentials("codebuddy-cn", null, "deepseek-v4.1-flash", {
        now: NOW,
        accountStrategy: "bonus-first",
        quotaSnapshotsLoader,
      });
      picks.push(selected.connectionId);
    }

    expect(picks).toEqual(["one", "two", "three", "one", "two"]);
  });

  it("bonus-first hands over to the next expiry day once the current cohort is spent", async () => {
    // The whole running day burns out, leaving only "one"'s later-day pack. The
    // urgent cohort is now just "one", so every request must land there rather
    // than falling back to a rotation that would let those credits lapse.
    const cursors = { one: 0, two: 0, three: 0 };
    let todaySpent = false;
    mocks.getProviderConnections.mockImplementation(async () => [
      { ...connection("one", 1, "codebuddy-cn"), lastUsedAt: null, consecutiveUseCount: cursors.one },
      { ...connection("two", 2, "codebuddy-cn"), lastUsedAt: null, consecutiveUseCount: cursors.two },
      { ...connection("three", 3, "codebuddy-cn"), lastUsedAt: null, consecutiveUseCount: cursors.three },
    ]);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin" });
    mocks.updateProviderConnection.mockImplementation(async (id, patch) => {
      if (patch.consecutiveUseCount !== undefined) cursors[id] = patch.consecutiveUseCount;
      return { ...connection(id, 1, "codebuddy-cn"), ...patch };
    });
    const quotaSnapshotsLoader = async () => [
      bonusRow("one", "bonus-1", { remaining: 900, limit: 900, resetAt: DAY_TWO + 3_600_000 }),
      bonusRow("two", "bonus-1", { remaining: todaySpent ? 0 : 50, limit: 50, resetAt: DAY_ONE + 3_600_000 }),
      bonusRow("three", "bonus-1", { remaining: todaySpent ? 0 : 40, limit: 40, resetAt: DAY_ONE + 2 * 3_600_000 }),
    ];

    const today = [];
    for (let call = 0; call < 2; call += 1) {
      const selected = await getProviderCredentials("codebuddy-cn", null, "deepseek-v4.1-flash", {
        now: NOW,
        accountStrategy: "bonus-first",
        quotaSnapshotsLoader,
      });
      today.push(selected.connectionId);
    }
    todaySpent = true;
    const later = [];
    for (let call = 0; call < 2; call += 1) {
      const selected = await getProviderCredentials("codebuddy-cn", null, "deepseek-v4.1-flash", {
        now: NOW,
        accountStrategy: "bonus-first",
        quotaSnapshotsLoader,
      });
      later.push(selected.connectionId);
    }

    expect(today).toEqual(["two", "three"]);
    expect(later).toEqual(["one", "one"]);
  });

  it("bonus-first leaves the rotation when only recurring refills remain", async () => {
    // No one-shot pack holds credits anywhere, so nothing can lapse and the
    // credit rotation has no ordering to apply: the established round-robin
    // order (LRU) must take over instead of collapsing onto one account.
    const lastUsed = { one: null, two: null, three: null };
    mocks.getProviderConnections.mockImplementation(async () => [
      { ...connection("one", 1, "codebuddy-cn"), lastUsedAt: lastUsed.one, consecutiveUseCount: 1 },
      { ...connection("two", 2, "codebuddy-cn"), lastUsedAt: lastUsed.two, consecutiveUseCount: 1 },
      { ...connection("three", 3, "codebuddy-cn"), lastUsedAt: lastUsed.three, consecutiveUseCount: 1 },
    ]);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin" });
    mocks.updateProviderConnection.mockImplementation(async (id, patch) => {
      if (patch.lastUsedAt !== undefined) lastUsed[id] = patch.lastUsedAt;
      return { ...connection(id, 1, "codebuddy-cn"), ...patch };
    });
    const quotaSnapshotsLoader = async () => [
      bonusRow("one", "monthly", { remaining: 500, limit: 500, resetAt: DAY_TWO + 3_600_000, recurring: true }),
      bonusRow("two", "monthly", { remaining: 500, limit: 500, resetAt: DAY_TWO + 3_600_000, recurring: true }),
      bonusRow("three", "monthly", { remaining: 500, limit: 500, resetAt: DAY_TWO + 3_600_000, recurring: true }),
    ];

    const picks = [];
    for (let call = 0; call < 3; call += 1) {
      const selected = await getProviderCredentials("codebuddy-cn", null, "deepseek-v4.1-flash", {
        now: NOW,
        accountStrategy: "bonus-first",
        quotaSnapshotsLoader,
      });
      picks.push(selected.connectionId);
    }

    expect(picks).toEqual(["one", "two", "three"]);
  });

  it("bonus-first prefers an earlier expiry day over a bigger later budget", async () => {
    // "one" holds 900 credits but they do not vanish until the next day; "two"
    // holds only 10 and they expire today, so "two" must go first.
    mocks.getProviderConnections.mockResolvedValue([
      { ...connection("one", 1, "codebuddy-cn"), lastUsedAt: new Date(NOW - 10_000).toISOString(), consecutiveUseCount: 1 },
      { ...connection("two", 2, "codebuddy-cn"), lastUsedAt: new Date(NOW - 1_000).toISOString(), consecutiveUseCount: 1 },
    ]);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin" });

    const selected = await getProviderCredentials("codebuddy-cn", null, "deepseek-v4.1-flash", {
      now: NOW,
      accountStrategy: "bonus-first",
      quotaSnapshotsLoader: async () => [
        bonusRow("one", "bonus-1", { remaining: 900, limit: 900, resetAt: DAY_TWO + 3_600_000 }),
        bonusRow("two", "bonus-1", { remaining: 10, limit: 10, resetAt: DAY_ONE + 3_600_000 }),
      ],
    });

    expect(selected.connectionId).toBe("two");
  });

  it("bonus-first cuts affinity once the pinned account's day has passed", async () => {
    // Call 1: "three" holds the only today-expiring budget, so the session pins
    // to it. Call 2: those credits are gone and "three" now only has a later
    // day, while "one" holds today's budget — the session must move to "one"
    // rather than stay pinned and let today's credits lapse.
    mocks.getProviderConnections.mockResolvedValue([
      { ...connection("one", 1, "codebuddy-cn"), lastUsedAt: new Date(NOW - 30_000).toISOString(), consecutiveUseCount: 1 },
      { ...connection("two", 2, "codebuddy-cn"), lastUsedAt: new Date(NOW - 20_000).toISOString(), consecutiveUseCount: 1 },
      { ...connection("three", 3, "codebuddy-cn"), lastUsedAt: new Date(NOW - 10_000).toISOString(), consecutiveUseCount: 1 },
    ]);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin" });

    let round = 0;
    const quotaSnapshotsLoader = async () => {
      round += 1;
      if (round === 1) {
        return [
          bonusRow("one", "bonus-1", { remaining: 100, limit: 100, resetAt: DAY_TWO + 3_600_000 }),
          bonusRow("two", "bonus-1", { remaining: 90, limit: 90, resetAt: DAY_TWO + 3_600_000 }),
          bonusRow("three", "bonus-1", { remaining: 50, limit: 50, resetAt: DAY_ONE + 3_600_000 }),
        ];
      }
      return [
        bonusRow("one", "bonus-1", { remaining: 100, limit: 100, resetAt: DAY_ONE + 20 * 3_600_000 }),
        bonusRow("two", "bonus-1", { remaining: 90, limit: 90, resetAt: DAY_TWO + 3_600_000 }),
        // "three"'s day-one pack is spent: nothing left that expires today.
        bonusRow("three", "bonus-1", { remaining: 0, limit: 50, resetAt: DAY_ONE + 3_600_000 }),
        bonusRow("three", "bonus-2", { remaining: 40, limit: 40, resetAt: DAY_TWO + 3_600_000 }),
      ];
    };

    const first = await getProviderCredentials("codebuddy-cn", null, "deepseek-v4.1-flash", {
      now: NOW,
      accountStrategy: "bonus-first",
      sessionId: "sess-day-cut",
      quotaSnapshotsLoader,
    });
    const second = await getProviderCredentials("codebuddy-cn", null, "deepseek-v4.1-flash", {
      now: NOW,
      accountStrategy: "bonus-first",
      sessionId: "sess-day-cut",
      quotaSnapshotsLoader,
    });

    expect(first.connectionId).toBe("three");
    expect(second.connectionId).toBe("one");
  });

  it("bonus-first keeps affinity while the pinned account still holds today's budget", async () => {
    // Call 1: only "three" holds a today-expiring budget, so the session pins to
    // it. Call 2: "one" now holds MORE credits on the same day (100 vs 50), so
    // the rotation order alone would move the session to "one". Affinity must
    // still win, because "three" can lose its own credits today just as well.
    mocks.getProviderConnections.mockResolvedValue([
      { ...connection("one", 1, "codebuddy-cn"), lastUsedAt: new Date(NOW - 30_000).toISOString(), consecutiveUseCount: 1 },
      { ...connection("three", 3, "codebuddy-cn"), lastUsedAt: new Date(NOW - 10_000).toISOString(), consecutiveUseCount: 1 },
    ]);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin" });

    let round = 0;
    const quotaSnapshotsLoader = async () => {
      round += 1;
      return [
        // "one" only joins the current day on call 2, with the larger budget.
        bonusRow("one", "bonus-1", {
          remaining: round === 1 ? 100 : 100,
          limit: 100,
          resetAt: round === 1 ? DAY_TWO + 3_600_000 : DAY_ONE + 20 * 3_600_000,
        }),
        bonusRow("three", "bonus-1", { remaining: 50, limit: 50, resetAt: DAY_ONE + 3_600_000 }),
      ];
    };

    const first = await getProviderCredentials("codebuddy-cn", null, "deepseek-v4.1-flash", {
      now: NOW,
      accountStrategy: "bonus-first",
      sessionId: "sess-day-keep",
      quotaSnapshotsLoader,
    });
    const second = await getProviderCredentials("codebuddy-cn", null, "deepseek-v4.1-flash", {
      now: NOW,
      accountStrategy: "bonus-first",
      sessionId: "sess-day-keep",
      quotaSnapshotsLoader,
    });

    expect(first.connectionId).toBe("three");
    // Ranking alone would pick "one" (100 > 50 on the same day); affinity holds.
    expect(second.connectionId).toBe("three");
  });

  it("bonus-first ignores a recurring refill refresh in favour of a bonus pack", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { ...connection("one", 1, "codebuddy-cn"), lastUsedAt: new Date(NOW - 1_000).toISOString(), consecutiveUseCount: 1 },
      { ...connection("two", 2, "codebuddy-cn"), lastUsedAt: new Date(NOW - 10_000).toISOString(), consecutiveUseCount: 1 },
    ]);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin" });

    const selected = await getProviderCredentials("codebuddy-cn", null, "deepseek-v4.1-flash", {
      now: NOW,
      accountStrategy: "bonus-first",
      quotaSnapshotsLoader: async () => [
        bonusRow("one", "monthly", { resetAt: NOW + 60_000, recurring: true }),
        bonusRow("two", "bonus-1", { resetAt: NOW + 86_400_000 }),
      ],
    });

    expect(selected.connectionId).toBe("two");
  });

  it("bonus-first falls back to round-robin order when only refills expire", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { ...connection("one", 1, "codebuddy-cn"), lastUsedAt: new Date(NOW - 10_000).toISOString(), consecutiveUseCount: 1 },
      { ...connection("two", 2, "codebuddy-cn"), lastUsedAt: new Date(NOW - 1_000).toISOString(), consecutiveUseCount: 1 },
    ]);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin" });

    const selected = await getProviderCredentials("codebuddy-cn", null, "deepseek-v4.1-flash", {
      now: NOW,
      accountStrategy: "bonus-first",
      // No one-shot pack anywhere: the soonest resetAt belongs to a refill that
      // merely refreshes, so the plain LRU round-robin order decides.
      quotaSnapshotsLoader: async () => [
        bonusRow("one", "monthly", { resetAt: NOW + 3_600_000, recurring: true }),
        bonusRow("two", "monthly", { resetAt: NOW + 600_000, recurring: true }),
      ],
    });

    expect(selected.connectionId).toBe("one");
  });

  it("bonus-first treats a whole-second expiry gap as a tie and keeps round-robin order", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { ...connection("one", 1, "codebuddy-cn"), lastUsedAt: new Date(NOW - 10_000).toISOString(), consecutiveUseCount: 1 },
      { ...connection("two", 2, "codebuddy-cn"), lastUsedAt: new Date(NOW - 1_000).toISOString(), consecutiveUseCount: 1 },
    ]);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin" });

    const selected = await getProviderCredentials("codebuddy-cn", null, "deepseek-v4.1-flash", {
      now: NOW,
      accountStrategy: "bonus-first",
      // "one" expires 999ms later — inside the one-second tie window.
      quotaSnapshotsLoader: async () => [
        bonusRow("one", "bonus-1", { resetAt: NOW + 3_600_999 }),
        bonusRow("two", "bonus-1", { resetAt: NOW + 3_600_000 }),
      ],
    });

    expect(selected.connectionId).toBe("one");
  });

  it("bonus-first keeps session affinity ahead of expiry order", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { ...connection("one", 1, "codebuddy-cn"), lastUsedAt: new Date(NOW - 10_000).toISOString(), consecutiveUseCount: 1 },
      { ...connection("two", 2, "codebuddy-cn"), lastUsedAt: new Date(NOW - 1_000).toISOString(), consecutiveUseCount: 1 },
    ]);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin" });
    const quotaSnapshotsLoader = async () => [
      bonusRow("one", "bonus-1", { resetAt: NOW + 86_400_000 }),
      bonusRow("two", "bonus-1", { resetAt: NOW + 3_600_000 }),
    ];

    const first = await getProviderCredentials("codebuddy-cn", null, "deepseek-v4.1-flash", {
      now: NOW,
      accountStrategy: "bonus-first",
      sessionId: "sess-bonus-affinity",
      quotaSnapshotsLoader,
    });
    const second = await getProviderCredentials("codebuddy-cn", null, "deepseek-v4.1-flash", {
      now: NOW,
      accountStrategy: "bonus-first",
      sessionId: "sess-bonus-affinity",
      quotaSnapshotsLoader,
    });

    expect(first.connectionId).toBe("two");
    expect(second.connectionId).toBe("two");
  });

  it("keeps the configured strategy when no per-request account strategy is supplied", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { ...connection("one", 1, "codebuddy-cn"), lastUsedAt: new Date(NOW - 10_000).toISOString(), consecutiveUseCount: 1 },
      { ...connection("two", 2, "codebuddy-cn"), lastUsedAt: new Date(NOW - 1_000).toISOString(), consecutiveUseCount: 1 },
    ]);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "fill-first" });

    const selected = await getProviderCredentials("codebuddy-cn", null, "deepseek-v4.1-flash", {
      now: NOW,
      quotaSnapshotsLoader: async () => [
        bonusRow("one", "bonus-1", { resetAt: NOW + 86_400_000 }),
        bonusRow("two", "bonus-1", { resetAt: NOW + 3_600_000 }),
      ],
    });

    expect(selected.connectionId).toBe("one");
  });

  it("codebuddy-cn balances round-robin by the rolling-24h token total", async () => {
    // "two" is the most recently used account, but "one" has burned far fewer
    // tokens today, so the new session must land on "one".
    mocks.getProviderConnections.mockResolvedValue([
      { ...connection("one", 1, "codebuddy-cn"), lastUsedAt: new Date(NOW - 10_000).toISOString(), consecutiveUseCount: 1 },
      { ...connection("two", 2, "codebuddy-cn"), lastUsedAt: new Date(NOW - 1_000).toISOString(), consecutiveUseCount: 1 },
    ]);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin", stickyRoundRobinLimit: 1 });
    mocks.getConnectionTokenTotals24h.mockResolvedValue(new Map([["one", 2_000], ["two", 10_000]]));

    const selected = await getProviderCredentials("codebuddy-cn", null, "deepseek-v4.1-flash", {
      now: NOW,
      sessionId: "sess-cbcn-balance",
    });

    expect(selected.connectionId).toBe("one");
    expect(mocks.getConnectionTokenTotals24h).toHaveBeenCalledWith(["one", "two"], expect.any(Date));
  });

  it("codebuddy-cn falls back to lastUsedAt when rolling-24h token totals tie", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { ...connection("one", 1, "codebuddy-cn"), lastUsedAt: new Date(NOW - 1_000).toISOString(), consecutiveUseCount: 1 },
      { ...connection("two", 2, "codebuddy-cn"), lastUsedAt: new Date(NOW - 10_000).toISOString(), consecutiveUseCount: 1 },
    ]);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin", stickyRoundRobinLimit: 1 });
    mocks.getConnectionTokenTotals24h.mockResolvedValue(new Map([["one", 5_000], ["two", 5_000]]));

    const selected = await getProviderCredentials("codebuddy-cn", null, "deepseek-v4.1-flash", {
      now: NOW,
      sessionId: "sess-cbcn-tie",
    });

    expect(selected.connectionId).toBe("two");
  });

  it("codebuddy-cn falls back to lastUsedAt when the token read fails", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { ...connection("one", 1, "codebuddy-cn"), lastUsedAt: new Date(NOW - 10_000).toISOString(), consecutiveUseCount: 1 },
      { ...connection("two", 2, "codebuddy-cn"), lastUsedAt: new Date(NOW - 1_000).toISOString(), consecutiveUseCount: 1 },
    ]);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin", stickyRoundRobinLimit: 1 });
    mocks.getConnectionTokenTotals24h.mockRejectedValue(new Error("db unavailable"));

    const selected = await getProviderCredentials("codebuddy-cn", null, "deepseek-v4.1-flash", {
      now: NOW,
      sessionId: "sess-cbcn-failopen",
    });

    expect(selected.connectionId).toBe("one");
  });

  it("does not read token totals for non-codebuddy providers", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { ...connection("one", 1), lastUsedAt: new Date(NOW - 10_000).toISOString(), consecutiveUseCount: 1 },
      connection("two", 2),
    ]);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin", stickyRoundRobinLimit: 1 });

    await getProviderCredentials("codex", null, "gpt-5.4", {
      now: NOW,
      sessionId: "sess-codex",
    });

    expect(mocks.getConnectionTokenTotals24h).not.toHaveBeenCalled();
  });

  it("codebuddy-cn skips an account at or above the request token budget", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { ...connection("one", 1, "codebuddy-cn"), lastUsedAt: new Date(NOW - 10_000).toISOString(), consecutiveUseCount: 1 },
      { ...connection("two", 2, "codebuddy-cn"), lastUsedAt: new Date(NOW - 1_000).toISOString(), consecutiveUseCount: 1 },
    ]);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin", stickyRoundRobinLimit: 1 });
    mocks.getConnectionTokenTotals24h.mockResolvedValue(new Map([["one", 180_000_000], ["two", 5_000]]));

    const selected = await getProviderCredentials("codebuddy-cn", null, "deepseek-v4.1-flash", {
      now: NOW,
      sessionId: "sess-cbcn-budget",
      connectionTokenBudget: 180_000_000,
    });

    expect(selected.connectionId).toBe("two");
    expect(mocks.getConnectionTokenTotals24h).toHaveBeenCalledTimes(1);
  });

  it("codebuddy-cn returns allRateLimited/503 when every account reaches the token budget", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { ...connection("one", 1, "codebuddy-cn"), lastUsedAt: new Date(NOW - 10_000).toISOString(), consecutiveUseCount: 1 },
      { ...connection("two", 2, "codebuddy-cn"), lastUsedAt: new Date(NOW - 1_000).toISOString(), consecutiveUseCount: 1 },
    ]);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin", stickyRoundRobinLimit: 1 });
    mocks.getConnectionTokenTotals24h.mockResolvedValue(new Map([["one", 190_000_000], ["two", 181_000_000]]));

    const selected = await getProviderCredentials("codebuddy-cn", null, "deepseek-v4.1-flash", {
      now: NOW,
      sessionId: "sess-cbcn-budget-all",
      connectionTokenBudget: 180_000_000,
    });

    expect(selected.allRateLimited).toBe(true);
    expect(selected.lastErrorCode).toBe(503);
  });

  it("ignores the token budget for non-codebuddy providers", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { ...connection("one", 1), lastUsedAt: new Date(NOW - 10_000).toISOString(), consecutiveUseCount: 1 },
      connection("two", 2),
    ]);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin", stickyRoundRobinLimit: 1 });

    const selected = await getProviderCredentials("codex", null, "gpt-5.4", {
      now: NOW,
      sessionId: "sess-codex-budget",
      connectionTokenBudget: 1,
    });

    expect(selected.connectionId).toBeDefined();
    expect(mocks.getConnectionTokenTotals24h).not.toHaveBeenCalled();
  });

  it("projects the committed round-robin revision instead of the stale selected row", async () => {
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "round-robin", stickyRoundRobinLimit: 3 });
    mocks.getProviderConnections.mockResolvedValue([
      { ...connection("one", 1), lastUsedAt: new Date(NOW - 1000).toISOString(), consecutiveUseCount: 1 },
      connection("two", 2),
    ]);
    const selected = await getProviderCredentials("codex", null, "gpt-5.4", {
      now: NOW,
      quotaSnapshotsLoader: async () => [],
    });
    expect(selected.connectionId).toBe("one");
    expect(selected._connection.updatedAt).toBe(new Date(NOW).toISOString());
    expect(selected._connection.consecutiveUseCount).toBe(2);
  });

  it("lets fresh compatible quota dominate fill-first priority", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("one", 1), connection("two", 2)]);
    const selected = await getProviderCredentials("codex", null, "gpt-5.4", {
      now: NOW,
      resourceKeys: ["model:gpt-5.4"],
      quotaSnapshotsLoader: async () => [providerRow("one", 10), providerRow("two", 90)],
    });
    expect(selected.connectionId).toBe("two");
    expect(mocks.getQuotaReservationPressure).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex",
      connectionIds: ["one", "two"],
    }));
  });

  it("subtracts committed provisional demand before ranking a final observed slot", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("one", 1), connection("two", 2)]);
    const finalSlot = providerRow("one", 1);
    finalSlot.amounts = {
      limitKind: "bounded",
      limit: 1,
      used: 0,
      remaining: 1,
      remainingRatio: 1,
      unit: "requests",
    };
    finalSlot.state = "available";
    mocks.getQuotaReservationPressure.mockResolvedValue(new Map([
      ["one", {
        activeCount: 0,
        lastSelectedAt: new Date(NOW - 1_000).toISOString(),
        debits: new Map([[
          quotaIdentityKey({
            connectionId: "one",
            provider: "codex",
            accountKey: "scope:connection",
            resourceKey: "model:gpt-5.4",
            dimensionKey: "requests:session",
          }),
          1,
        ]]),
      }],
      ["two", { activeCount: 0, lastSelectedAt: null, debits: new Map() }],
    ]));

    const selected = await getProviderCredentials("codex", null, "gpt-5.4", {
      now: NOW,
      resourceKeys: ["model:gpt-5.4"],
      quotaSnapshotsLoader: async () => [finalSlot, providerRow("two", 50)],
    });

    expect(selected.connectionId).toBe("two");
  });

  it("filters a below-floor account and selects a compatible account above its floor", async () => {
    mocks.getSettings.mockResolvedValue({ quotaSelection: { routingFloorEnabled: true, routingFloorRatio: 0.2 } });
    mocks.getProviderConnections.mockResolvedValue([connection("one", 1), connection("two", 2)]);
    const selected = await getProviderCredentials("codex", null, "gpt-5.4", {
      now: NOW,
      resourceKeys: ["model:gpt-5.4"],
      quotaSnapshotsLoader: async () => [providerRow("one", 10), providerRow("two", 90)],
    });

    expect(selected.connectionId).toBe("two");
  });

  it("returns a fixed local 503 when every comparable account is below its routing floor", async () => {
    mocks.getSettings.mockResolvedValue({ quotaSelection: { routingFloorEnabled: true, routingFloorRatio: 0.2 } });
    mocks.getProviderConnections.mockResolvedValue([connection("one", 1), connection("two", 2)]);
    const selected = await getProviderCredentials("codex", null, "gpt-5.4", {
      now: NOW,
      resourceKeys: ["model:gpt-5.4"],
      quotaSnapshotsLoader: async () => [providerRow("one", 10), providerRow("two", 20)],
    });

    expect(selected).toMatchObject({
      allRateLimited: true,
      localQuotaFloor: true,
      lastErrorCode: 503,
      lastError: "Provider quota routing floor reached",
      retryAfter: null,
    });
  });

  it("keeps an untracked sibling eligible when a comparable account is below floor", async () => {
    mocks.getSettings.mockResolvedValue({ quotaSelection: { routingFloorEnabled: true, routingFloorRatio: 0.2 } });
    mocks.getProviderConnections.mockResolvedValue([connection("one", 1), connection("two", 2)]);
    const selected = await getProviderCredentials("codex", null, "gpt-5.4", {
      now: NOW,
      resourceKeys: ["model:gpt-5.4"],
      quotaSnapshotsLoader: async () => [providerRow("one", 10)],
    });

    expect(selected.connectionId).toBe("two");
    expect(selected._quotaPreflight.reason).toBe("missing");
  });

  it("enforces routing floors for ratio-only token windows", async () => {
    mocks.getSettings.mockResolvedValue({
      quotaSelection: {
        providers: {
          glm: {
            dimensions: {
              "tokens:session": { routingFloorEnabled: true, routingFloorRatio: 0.2 },
            },
          },
        },
      },
    });
    mocks.getProviderConnections.mockResolvedValue([
      connection("one", 1, "glm"),
      connection("two", 2, "glm"),
    ]);
    const selected = await getProviderCredentials("glm", null, "glm-5", {
      now: NOW,
      quotaSnapshotsLoader: async () => [
        providerRow("one", 10, {
          provider: "glm",
          resourceKey: "scope:account",
          dimensionKey: "tokens:session",
          unit: "tokens",
          sourceId: "glm:coding-plan-quota:v1",
        }),
        providerRow("two", 90, {
          provider: "glm",
          resourceKey: "scope:account",
          dimensionKey: "tokens:session",
          unit: "tokens",
          sourceId: "glm:coding-plan-quota:v1",
        }),
      ],
    });

    expect(selected.connectionId).toBe("two");
    expect(selected._quotaPreflight.quotaProfile.reservationAlternatives).toEqual([]);
  });

  it("preserves fill-first order when observations are stale or untracked", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("one", 1), connection("two", 2)]);
    const selected = await getProviderCredentials("codex", null, "gpt-5.4", {
      now: NOW,
      quotaSnapshotsLoader: async () => [],
    });
    expect(selected.connectionId).toBe("one");
    expect(mocks.getQuotaReservationPressure).not.toHaveBeenCalled();
  });

  it("does not serialize unrelated providers behind a slow quota lookup", async () => {
    let releaseCodex;
    const codexSnapshots = new Promise((resolve) => { releaseCodex = resolve; });
    const codexLoader = vi.fn(() => codexSnapshots);
    const claudeLoader = vi.fn().mockResolvedValue([]);
    mocks.getProviderConnections.mockImplementation(async ({ provider }) => [
      connection(`${provider}-one`, 1, provider),
    ]);

    const pendingCodex = getProviderCredentials("codex", null, "gpt-5.4", {
      now: NOW,
      quotaSnapshotsLoader: codexLoader,
    });
    await vi.waitFor(() => expect(codexLoader).toHaveBeenCalledOnce());

    const claude = await getProviderCredentials("claude", null, "claude-sonnet", {
      now: NOW,
      quotaSnapshotsLoader: claudeLoader,
    });
    expect(claude.connectionId).toBe("claude-one");
    expect(claudeLoader).toHaveBeenCalledOnce();

    releaseCodex([]);
    expect((await pendingCodex).connectionId).toBe("codex-one");
  });

  it("performs no credential or quota work for a pre-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const quotaSnapshotsLoader = vi.fn();
    await expect(getProviderCredentials("codex", null, "gpt-5.4", {
      signal: controller.signal,
      quotaSnapshotsLoader,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.getProviderConnections).not.toHaveBeenCalled();
    expect(quotaSnapshotsLoader).not.toHaveBeenCalled();
  });
});
