import { beforeEach, describe, expect, it, vi } from "vitest";

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
const { resetPoolRefreshState } = await import("../../src/shared/services/quotaPoolRefresh.js");

const NOW = Date.parse("2026-11-18T06:00:00.000Z");
const HOUR = 3_600_000;
const PROVIDER = "codebuddy-cn";

function connection(id, priority, provider = PROVIDER) {
  return {
    id,
    provider,
    name: id,
    authType: "oauth",
    accessToken: `token-${id}`,
    refreshToken: `refresh-${id}`,
    priority,
    isActive: true,
    updatedAt: new Date(NOW - 60_000).toISOString(),
  };
}

function poolRow(connectionId, name, { remaining, resetIn, provider = PROVIDER, recurring = false } = {}) {
  const limit = 100;
  return {
    identity: {
      connectionId,
      provider,
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
      observedAt: new Date(NOW - 1_000).toISOString(),
      staleAt: new Date(NOW + 60_000).toISOString(),
      resetAt: new Date(NOW + resetIn).toISOString(),
      cooldownUntil: null,
    },
    provenance: {
      sourceType: "provider_api",
      sourceId: `${PROVIDER}:billing-meter:v1`,
      reasonCode: null,
      metadata: { recurring },
    },
  };
}

function loader(rows) {
  return async () => rows;
}

describe("header-driven allowance strategies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPoolRefreshState();
    mocks.getSettings.mockResolvedValue({});
    mocks.getProxyPools.mockResolvedValue([]);
    mocks.getQuotaFetchState.mockResolvedValue(null);
    mocks.getQuotaReservationPressure.mockResolvedValue(new Map());
    mocks.getConnectionTokenTotals24h.mockResolvedValue(new Map());
    mocks.updateProviderConnection.mockImplementation(async (id, patch) => ({
      ...connection(id, 1),
      ...patch,
      updatedAt: new Date(NOW).toISOString(),
    }));
  });

  it("least-used picks the account with the most allowance left, not the highest priority", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("first", 1), connection("second", 2)]);
    const selected = await getProviderCredentials(PROVIDER, null, "claude-sonnet-4", {
      now: NOW,
      accountStrategy: "least-used",
      quotaSnapshotsLoader: loader([
        poolRow("first", "bonus-1", { remaining: 10, resetIn: 4 * HOUR }),
        poolRow("second", "bonus-1", { remaining: 90, resetIn: 4 * HOUR }),
      ]),
    });
    expect(selected.connectionId).toBe("second");
  });

  it("use-before-expiry picks the allowance that is lost soonest", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("first", 1), connection("second", 2)]);
    const selected = await getProviderCredentials(PROVIDER, null, "claude-sonnet-4", {
      now: NOW,
      accountStrategy: "use-before-expiry",
      quotaSnapshotsLoader: loader([
        poolRow("first", "bonus-1", { remaining: 90, resetIn: 5 * 24 * HOUR }),
        poolRow("second", "bonus-1", { remaining: 90, resetIn: HOUR }),
      ]),
    });
    expect(selected.connectionId).toBe("second");
  });

  it("is inert for every other provider, whatever the header says", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("first", 1, "codex"), connection("second", 2, "codex")]);
    const selected = await getProviderCredentials("codex", null, "gpt-5.4", {
      now: NOW,
      accountStrategy: "least-used",
      // Inverted on purpose: if the strategy leaked, this would pick "second".
      quotaSnapshotsLoader: loader([
        poolRow("first", "monthly", { remaining: 10, resetIn: 4 * HOUR, provider: "codex" }),
        poolRow("second", "monthly", { remaining: 90, resetIn: 4 * HOUR, provider: "codex" }),
      ]),
    });
    expect(selected.connectionId).toBe("first");
    // The pool is not read on behalf of a provider the header does not cover.
    expect(mocks.getConnectionTokenTotals24h).not.toHaveBeenCalled();
  });

  it("keeps a conversation on its account while the turn is open, then re-plans", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("first", 1), connection("second", 2)]);
    const snapshots = loader([
      poolRow("first", "bonus-1", { remaining: 10, resetIn: 4 * HOUR }),
      poolRow("second", "bonus-1", { remaining: 90, resetIn: 4 * HOUR }),
    ]);

    const first = await getProviderCredentials(PROVIDER, null, "claude-sonnet-4", {
      now: NOW, accountStrategy: "least-used", sessionId: "sess-a", conversationTurn: 1,
      quotaSnapshotsLoader: snapshots,
    });
    expect(first.connectionId).toBe("second");

    // Same turn, tool round-trips: the plan would still say "second", but the
    // point is that the affinity alone holds even when it would say otherwise.
    const stillSameTurn = await getProviderCredentials(PROVIDER, null, "claude-sonnet-4", {
      now: NOW, accountStrategy: "least-used", sessionId: "sess-a", conversationTurn: 1,
      quotaSnapshotsLoader: loader([
        poolRow("first", "bonus-1", { remaining: 90, resetIn: 4 * HOUR }),
        poolRow("second", "bonus-1", { remaining: 10, resetIn: 4 * HOUR }),
      ]),
    });
    expect(stillSameTurn.connectionId).toBe("second");

    // A new turn re-plans and follows the readings again.
    const newTurn = await getProviderCredentials(PROVIDER, null, "claude-sonnet-4", {
      now: NOW, accountStrategy: "least-used", sessionId: "sess-a", conversationTurn: 2,
      quotaSnapshotsLoader: loader([
        poolRow("first", "bonus-1", { remaining: 90, resetIn: 4 * HOUR }),
        poolRow("second", "bonus-1", { remaining: 10, resetIn: 4 * HOUR }),
      ]),
    });
    expect(newTurn.connectionId).toBe("first");
  });

  it("reads the whole pool in the background instead of only the account it picked", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      connection("first", 1), connection("second", 2), connection("third", 3),
    ]);
    const quotaRefresher = vi.fn().mockResolvedValue(null);
    await getProviderCredentials(PROVIDER, null, "claude-sonnet-4", {
      now: NOW,
      accountStrategy: "least-used",
      quotaRefresher,
      quotaSnapshotsLoader: loader([]),
    });
    // The refresh runs after the selection returns; one tick is enough here.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(quotaRefresher.mock.calls.map(([selected]) => selected.id)).toEqual(["first", "second", "third"]);
  });

  it("does not read a pool when no allowance strategy is in force", async () => {
    mocks.getProviderConnections.mockResolvedValue([connection("first", 1), connection("second", 2)]);
    const quotaRefresher = vi.fn().mockResolvedValue(null);
    await getProviderCredentials(PROVIDER, null, "claude-sonnet-4", {
      now: NOW,
      quotaRefresher,
      quotaSnapshotsLoader: loader([]),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(quotaRefresher).not.toHaveBeenCalled();
  });
});
