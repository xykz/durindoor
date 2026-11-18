import { describe, expect, it } from "vitest";
import {
  ACCOUNT_STRATEGIES,
  ACCOUNT_STRATEGY_PROVIDERS,
  accountStrategyAppliesTo,
  parseAccountStrategy,
} from "../../src/shared/utils/accountStrategy.js";
import {
  USAGE_TIER,
  countConversationTurns,
  describeAccountUsage,
  planAccountUsage,
  rankAccountUsage,
  readingAt,
} from "../../src/shared/services/accountUsagePlan.js";
import {
  isPoolRefreshInflight,
  refusalRefreshesAllowance,
  resetPoolRefreshState,
  schedulePoolRefresh,
} from "../../src/shared/services/quotaPoolRefresh.js";
import {
  QUOTA_SELECTION_DEFAULTS,
  resolvePoolRefreshIntervalMs,
} from "../../open-sse/config/quotaSelection.js";
import { getProviderQuotaConfig } from "../../open-sse/config/providerQuota.js";

const NOW = Date.parse("2026-11-18T06:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PROVIDER = "codebuddy-cn";
const SOURCE_ID = "codebuddy-cn:billing-meter:v1";

function row(connectionId, name, {
  remaining = 100,
  limit = 100,
  resetAt = null,
  recurring = true,
  state = null,
  connectionProvider = PROVIDER,
} = {}) {
  const ratio = limit > 0 ? remaining / limit : null;
  return {
    identity: {
      connectionId,
      provider: connectionProvider,
      accountKey: "scope:connection",
      resourceKey: `package:${name}`,
      dimensionKey: "credits:capacity",
    },
    state: state || (remaining === 0 ? "exhausted" : ratio !== null && ratio <= 0.1 ? "low" : "available"),
    amounts: { limitKind: "bounded", limit, used: limit - remaining, remaining, remainingRatio: ratio, unit: "credits" },
    timing: {
      observedAt: new Date(NOW - 1_000).toISOString(),
      staleAt: new Date(NOW + 60_000).toISOString(),
      resetAt: resetAt === null ? null : new Date(resetAt).toISOString(),
      cooldownUntil: null,
    },
    provenance: { sourceType: "provider_api", sourceId: SOURCE_ID, reasonCode: null, metadata: { recurring } },
  };
}

function connection(id, priority = 1) {
  return { id, provider: PROVIDER, priority, isActive: true };
}

describe("x-account-strategy header parsing", () => {
  it("accepts the two allowance strategies and nothing else", () => {
    expect(ACCOUNT_STRATEGIES).toEqual(["least-used", "use-before-expiry"]);
    expect(parseAccountStrategy("least-used")).toBe("least-used");
    expect(parseAccountStrategy("  USE-BEFORE-EXPIRY ")).toBe("use-before-expiry");
    expect(parseAccountStrategy("round-robin")).toBeNull();
    expect(parseAccountStrategy("bonus-first")).toBeNull();
    expect(parseAccountStrategy("")).toBeNull();
    expect(parseAccountStrategy(null)).toBeNull();
    expect(parseAccountStrategy(7)).toBeNull();
  });

  it("is scoped to codebuddy-cn so another provider's routing cannot be reshaped", () => {
    expect(ACCOUNT_STRATEGY_PROVIDERS).toEqual(["codebuddy-cn"]);
    expect(accountStrategyAppliesTo("codebuddy-cn", "least-used")).toBe(true);
    expect(accountStrategyAppliesTo("codebuddy-cn", "use-before-expiry")).toBe(true);
    expect(accountStrategyAppliesTo("codex", "least-used")).toBe(false);
    expect(accountStrategyAppliesTo(null, "least-used")).toBe(false);
    expect(accountStrategyAppliesTo("codebuddy-cn", null)).toBe(false);
    expect(accountStrategyAppliesTo("codebuddy-cn", "bogus")).toBe(false);
  });
});

describe("readingAt — a stale reading stays usable", () => {
  it("counts a window past its reset as renewed instead of unknown", () => {
    const stale = readingAt(row("one", "daily", { remaining: 0, resetAt: NOW - HOUR, state: "exhausted" }), NOW);
    // The reset has passed: the allowance it guarded is whole again.
    expect(stale.remainingShare).toBe(1);
    expect(stale.expiresAt).toBeNull();
    expect(stale.spent).toBe(false);
  });

  it("keeps a future reset and keeps a cooldown", () => {
    const live = readingAt(row("one", "daily", { remaining: 25, resetAt: NOW + HOUR }), NOW);
    expect(live.remainingShare).toBeCloseTo(0.25, 12);
    expect(live.expiresAt).toBe(NOW + HOUR);
    expect(live.spent).toBe(false);

    const cooling = readingAt(row("one", "daily", { remaining: 25, resetAt: NOW + HOUR, state: "cooldown" }), NOW);
    expect(cooling.spent).toBe(true);
  });
});

describe("describeAccountUsage — the tightest pool decides", () => {
  it("takes the fullest window's share, not an average", () => {
    const usage = describeAccountUsage(
      [
        row("one", "monthly", { remaining: 900, limit: 1000, resetAt: NOW + 30 * DAY }),
        row("one", "daily", { remaining: 10, limit: 100, resetAt: NOW + HOUR }),
      ],
      NOW
    );
    // 90% used on the daily pool: the account cannot serve much even though the
    // monthly pool is nearly untouched.
    expect(usage.usedShare).toBeCloseTo(0.9, 12);
    expect(usage.tier).toBe(USAGE_TIER.LOW);
    // The soonest loss among pools that still hold something.
    expect(usage.expiresAt).toBe(NOW + HOUR);
  });

  it("reports the share at the tier boundaries magpie uses", () => {
    const low = describeAccountUsage([row("one", "daily", { remaining: 10, limit: 100, resetAt: NOW + HOUR })], NOW);
    expect(low.usedShare).toBeCloseTo(0.9, 12);
    expect(low.tier).toBe(USAGE_TIER.LOW);

    const spent = describeAccountUsage([row("one", "daily", { remaining: 1, limit: 100, resetAt: NOW + HOUR })], NOW);
    expect(spent.tier).toBe(USAGE_TIER.SPENT);

    const room = describeAccountUsage([row("one", "daily", { remaining: 50, limit: 100, resetAt: NOW + HOUR })], NOW);
    expect(room.tier).toBe(USAGE_TIER.ROOM);
  });

  it("reports an account with no readings as unknown, not as unused", () => {
    const usage = describeAccountUsage([], NOW);
    expect(usage.known).toBe(false);
    expect(usage.usedShare).toBeNull();
    expect(usage.tier).toBe(USAGE_TIER.UNKNOWN);
  });

  it("ignores runtime response-header rows, which say nothing about the pool", () => {
    const plan = planAccountUsage([connection("one")], [
      { ...row("one", "daily", { remaining: 1 }), provenance: { sourceType: "response_headers", sourceId: null } },
    ], { strategy: "least-used", now: NOW });
    expect(plan[0].tier).toBe(USAGE_TIER.UNKNOWN);
  });
});

describe("rankAccountUsage — least-used", () => {
  it("orders known-with-room, then unknown, then low, then spent", () => {
    const plan = planAccountUsage(
      [connection("spent"), connection("unknown"), connection("low"), connection("room"), connection("roomer")],
      [
        row("spent", "daily", { remaining: 1, limit: 100, resetAt: NOW + HOUR }),
        row("low", "daily", { remaining: 10, limit: 100, resetAt: NOW + HOUR }),
        row("room", "daily", { remaining: 50, limit: 100, resetAt: NOW + HOUR }),
        row("roomer", "daily", { remaining: 80, limit: 100, resetAt: NOW + HOUR }),
      ],
      { strategy: "least-used", now: NOW }
    );
    expect(plan.map((entry) => entry.connectionId)).toEqual(["roomer", "room", "unknown", "low", "spent"]);
  });

  it("never lets an unread account masquerade as an unused one", () => {
    // The magpie #4535 failure: paid balance drained while a subscription pool
    // nobody had read sat idle.
    const plan = planAccountUsage(
      [connection("paid"), connection("subscription")],
      [row("paid", "balance", { remaining: 0, limit: 100, resetAt: NOW + HOUR })],
      { strategy: "least-used", now: NOW }
    );
    expect(plan.map((entry) => entry.connectionId)).toEqual(["subscription", "paid"]);
  });

  it("ranks a renewed window as fully available rather than as exhausted", () => {
    const plan = planAccountUsage(
      [connection("renewed"), connection("half")],
      [
        row("renewed", "daily", { remaining: 0, limit: 100, resetAt: NOW - HOUR, state: "exhausted" }),
        row("half", "daily", { remaining: 50, limit: 100, resetAt: NOW + HOUR }),
      ],
      { strategy: "least-used", now: NOW }
    );
    expect(plan.map((entry) => entry.connectionId)).toEqual(["renewed", "half"]);
  });
});

describe("rankAccountUsage — use-before-expiry", () => {
  it("orders by soonest loss among accounts that still hold allowance", () => {
    const plan = planAccountUsage(
      [connection("later"), connection("soon"), connection("unknown")],
      [
        row("later", "bonus", { remaining: 90, limit: 100, resetAt: NOW + 5 * DAY }),
        row("soon", "bonus", { remaining: 90, limit: 100, resetAt: NOW + HOUR }),
      ],
      { strategy: "use-before-expiry", now: NOW }
    );
    // `unknown` tells no expiry, so it goes after the accounts that do.
    expect(plan.map((entry) => entry.connectionId)).toEqual(["soon", "later", "unknown"]);
  });

  it("burns a nearly spent pack that is about to be lost before a fresh one", () => {
    // Deliberate departure from magpie's free-seat partitioning: `expiring` on a
    // single provider must not sink the account whose allowance is about to be
    // wasted, which is the whole point of the strategy here.
    const plan = planAccountUsage(
      [connection("fresh"), connection("nearly-spent")],
      [
        row("fresh", "bonus", { remaining: 100, limit: 100, resetAt: NOW + 3 * DAY }),
        row("nearly-spent", "bonus", { remaining: 3, limit: 100, resetAt: NOW + HOUR }),
      ],
      { strategy: "use-before-expiry", now: NOW }
    );
    expect(plan.map((entry) => entry.connectionId)).toEqual(["nearly-spent", "fresh"]);
  });

  it("still sinks an empty or cooling account", () => {
    const plan = planAccountUsage(
      [connection("empty"), connection("cooling"), connection("usable")],
      [
        row("empty", "bonus", { remaining: 0, limit: 100, resetAt: NOW + HOUR, state: "exhausted" }),
        row("cooling", "bonus", { remaining: 50, limit: 100, resetAt: NOW + 2 * HOUR, state: "cooldown" }),
        row("usable", "bonus", { remaining: 50, limit: 100, resetAt: NOW + 4 * HOUR }),
      ],
      { strategy: "use-before-expiry", now: NOW }
    );
    expect(plan.map((entry) => entry.connectionId)).toEqual(["usable", "cooling", "empty"]);
  });

  it("spends the fuller of two packs that expire together", () => {
    // Both packs are lost at the same moment, so the amount wasted is whichever
    // one is left unspent. Ranking the emptier one first would waste the
    // fuller one instead, so the roomier account goes first.
    const plan = planAccountUsage(
      [connection("full"), connection("emptier")],
      [
        row("full", "bonus-a", { remaining: 100, limit: 100, resetAt: NOW + HOUR }),
        row("emptier", "bonus-b", { remaining: 20, limit: 100, resetAt: NOW + HOUR }),
      ],
      { strategy: "use-before-expiry", now: NOW }
    );
    expect(plan.map((entry) => entry.connectionId)).toEqual(["full", "emptier"]);
  });
});

describe("countConversationTurns — what keeps a turn open", () => {
  it("counts user turns and ignores tool round-trips", () => {
    const body = {
      messages: [
        { role: "user", content: "fix the build" },
        { role: "assistant", content: "", tool_calls: [{ id: "1" }] },
        { role: "tool", tool_call_id: "1", content: "exit 1" },
        { role: "assistant", content: "", tool_calls: [{ id: "2" }] },
        { role: "tool", tool_call_id: "2", content: "exit 0" },
      ],
    };
    expect(countConversationTurns(body)).toBe(1);
  });

  it("counts a Claude-shaped tool result as the same turn", () => {
    const body = {
      messages: [
        { role: "user", content: "run the tests" },
        { role: "assistant", content: [{ type: "tool_use", id: "a" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }] },
      ],
    };
    expect(countConversationTurns(body)).toBe(1);
  });

  it("opens a new turn for the user's next words", () => {
    const body = {
      messages: [
        { role: "user", content: "run the tests" },
        { role: "assistant", content: [{ type: "tool_use", id: "a" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }] },
        { role: "assistant", content: "all green" },
        { role: "user", content: "now commit" },
      ],
    };
    expect(countConversationTurns(body)).toBe(2);
  });

  it("treats an attachment with no words as the user's own message", () => {
    const body = {
      messages: [
        { role: "user", content: "look" },
        { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] },
      ],
    };
    expect(countConversationTurns(body)).toBe(2);
  });

  it("reads the Responses shape too, and returns null when unreadable", () => {
    expect(countConversationTurns({ input: [{ role: "user", content: "hi" }] })).toBe(1);
    expect(countConversationTurns({})).toBeNull();
    expect(countConversationTurns(null)).toBeNull();
  });
});

describe("schedulePoolRefresh — warm the pool without blocking a request", () => {
  it("starts one read for the whole pool and never a second while it runs", async () => {
    resetPoolRefreshState();
    const seen = [];
    let finish;
    const refresh = (conn) => {
      seen.push(conn.id);
      return new Promise((resolve) => { finish = resolve; });
    };
    const started = schedulePoolRefresh({
      provider: PROVIDER,
      connections: [connection("one"), connection("two")],
      refresh,
      now: NOW,
    });
    expect(started).toBe(true);
    expect(isPoolRefreshInflight(PROVIDER)).toBe(true);
    // A second request in the same millisecond must not add a second read.
    expect(schedulePoolRefresh({
      provider: PROVIDER,
      connections: [connection("one")],
      refresh,
      now: NOW,
    })).toBe(false);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(seen[0]).toBe("one");
  });

  it("honours the interval and does nothing without connections", () => {
    resetPoolRefreshState();
    const refresh = async () => {};
    expect(schedulePoolRefresh({ provider: PROVIDER, connections: [], refresh, now: NOW })).toBe(false);
    expect(schedulePoolRefresh({ provider: PROVIDER, connections: [connection("one")], refresh, now: NOW })).toBe(true);
    // Within the interval: no read.
    expect(schedulePoolRefresh({
      provider: PROVIDER,
      connections: [connection("one")],
      refresh,
      now: NOW + 1_000,
      intervalMs: 60_000,
    })).toBe(false);
  });

  it("swallows a per-account failure and keeps going", async () => {
    resetPoolRefreshState();
    const seen = [];
    await new Promise((resolve) => {
      schedulePoolRefresh({
        provider: PROVIDER,
        connections: [connection("bad"), connection("good")],
        refresh: async (conn) => {
          seen.push(conn.id);
          if (conn.id === "bad") throw new Error("upstream down");
        },
        now: NOW,
        intervalMs: 0,
      });
      setTimeout(resolve, 0);
    });
    expect(seen).toEqual(["bad", "good"]);
    expect(isPoolRefreshInflight(PROVIDER)).toBe(false);
  });

  it("only asks for a re-read on evidence about the allowance", () => {
    expect(refusalRefreshesAllowance(429, PROVIDER)).toBe(true);
    expect(refusalRefreshesAllowance(402, PROVIDER)).toBe(true);
    expect(refusalRefreshesAllowance(500, PROVIDER)).toBe(false);
    expect(refusalRefreshesAllowance(400, PROVIDER)).toBe(false);
    expect(refusalRefreshesAllowance(429, null)).toBe(false);
  });
});

describe("codebuddy-cn allowance configuration", () => {
  it("keeps a reading usable across two pool refreshes", () => {
    const config = getProviderQuotaConfig(PROVIDER);
    // 60s (the global default) expired between two 60s refreshes, which is what
    // left the pool unreadable while an allowance strategy tried to rank it.
    expect(config.freshnessMs).toBe(5 * 60 * 1000);
    expect(config.freshnessMs).toBeGreaterThan(QUOTA_SELECTION_DEFAULTS.poolRefreshIntervalMs);
  });

  it("falls back to the global pool interval and accepts a provider override", () => {
    expect(resolvePoolRefreshIntervalMs({}, PROVIDER)).toBe(QUOTA_SELECTION_DEFAULTS.poolRefreshIntervalMs);
    expect(resolvePoolRefreshIntervalMs({ providers: { [PROVIDER]: { poolRefreshIntervalMs: 120_000 } } }, PROVIDER))
      .toBe(120_000);
  });
});
