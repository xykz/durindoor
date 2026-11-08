import { describe, expect, it } from "vitest";
import { QUOTA_SELECTION_DEFAULTS } from "../../open-sse/config/quotaSelection.js";
import { bonusBucketOf, compareBonusRotation } from "../../src/shared/services/quotaSelection.js";
import { evaluateProviderQuotaPreflight } from "../../src/shared/services/providerQuotaPreflight.js";

const NOW = Date.parse("2026-07-10T12:00:00.000Z");
const PROVIDER = "codebuddy-cn";
const SOURCE_ID = "codebuddy-cn:billing-meter:v1";

function packageRow(connectionId, name, {
  remaining = 10,
  limit = 10,
  resetAt = null,
  recurring = false,
  state = remaining === 0 ? "exhausted" : "available",
} = {}) {
  return {
    identity: {
      connectionId,
      provider: PROVIDER,
      accountKey: "scope:connection",
      resourceKey: `package:${name}`,
      dimensionKey: "credits:capacity",
    },
    state,
    amounts: {
      limitKind: "bounded",
      limit,
      used: limit - remaining,
      remaining,
      remainingRatio: limit > 0 ? remaining / limit : null,
      unit: "credits",
    },
    timing: {
      observedAt: new Date(NOW - 1_000).toISOString(),
      staleAt: new Date(NOW + 60_000).toISOString(),
      resetAt: resetAt === null ? null : new Date(resetAt).toISOString(),
      cooldownUntil: null,
    },
    provenance: { sourceType: "provider_api", sourceId: SOURCE_ID, reasonCode: null, metadata: { recurring } },
  };
}

function profileFor(snapshots, connectionId = "one") {
  return evaluateProviderQuotaPreflight(snapshots, {
    connectionId,
    provider: PROVIDER,
    resourceKeys: [],
    now: NOW,
  }).quotaProfile;
}

/** A one-shot pool expiring at `day` + `hour` (UTC), holding `remaining` credits. */
function pack(day, hour, remaining, extra = {}) {
  return {
    resourceKey: `package:bonus-${day}-${hour}`,
    ratio: 1,
    resetAt: `${day}T${String(hour).padStart(2, "0")}:00:00.000Z`,
    recurring: false,
    remaining,
    ...extra,
  };
}

describe("routing window expiry metadata", () => {
  it("carries resetAt, the recurring flag, and the absolute amount", () => {
    const profile = profileFor([
      packageRow("one", "monthly", { remaining: 500, limit: 500, resetAt: NOW + 30 * 86_400_000, recurring: true }),
      packageRow("one", "bonus-1", { remaining: 5, limit: 100, resetAt: NOW + 3_600_000 }),
    ]);

    expect(profile.routingWindows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resourceKey: "package:monthly",
        resetAt: new Date(NOW + 30 * 86_400_000).toISOString(),
        recurring: true,
        remaining: 500,
      }),
      // ratio 0.05 and remaining 5 describe the same pack; only `remaining` is
      // comparable against another pack's amount.
      expect.objectContaining({
        resourceKey: "package:bonus-1",
        resetAt: new Date(NOW + 3_600_000).toISOString(),
        recurring: false,
        ratio: 0.05,
        remaining: 5,
      }),
    ]));
  });

  it("reports null when the observation has no expiry or no recurring marker", () => {
    const [window] = profileFor([packageRow("one", "bonus-1", { resetAt: null, recurring: null })]).routingWindows;
    expect(window).toMatchObject({ resetAt: null, recurring: null });
  });

  it("keeps the pre-existing window fields intact", () => {
    const [window] = profileFor([packageRow("one", "bonus-1", { resetAt: NOW + 60_000 })]).routingWindows;
    expect(window).toMatchObject({
      resourceKey: "package:bonus-1",
      dimensionKey: "credits:capacity",
      unit: "credits",
      ratio: 1,
    });
  });
});

describe("bonusBucketOf", () => {
  it("groups same-day packs and sums their credits", () => {
    // The real data's normal shape: several packs share one expiry day
    // (e.g. 100 + 100 + 5 = 205 on 2026-11-08).
    const bucket = bonusBucketOf({
      routingWindows: [
        pack("2026-11-08", 18, 100),
        pack("2026-11-08", 22, 100),
        pack("2026-11-08", 23, 5),
      ],
    }, NOW);

    expect(bucket).toEqual({ day: "2026-11-08", total: 205, earliestResetAt: Date.parse("2026-11-08T18:00:00.000Z") });
  });

  it("ranks by the earliest expiry day, not the largest total", () => {
    const bucket = bonusBucketOf({
      routingWindows: [
        pack("2026-11-10", 1, 90),
        pack("2026-11-09", 2, 10),
        pack("2026-11-09", 3, 40),
      ],
    }, NOW);

    expect(bucket).toEqual({ day: "2026-11-09", total: 50, earliestResetAt: Date.parse("2026-11-09T02:00:00.000Z") });
  });

  it("ignores recurring refills, empty packs, past expiries, and unknown expiries", () => {
    const bucket = bonusBucketOf({
      routingWindows: [
        { resourceKey: "package:monthly", ratio: 1, remaining: 500, resetAt: "2026-07-11T00:00:00.000Z", recurring: true },
        pack("2026-11-08", 1, 0),
        { ...pack("2026-11-08", 2, 50), resetAt: "2026-07-09T00:00:00.000Z" },
        { ...pack("2026-11-08", 3, 50), resetAt: null },
        { ...pack("2026-11-08", 4, 50), resetAt: "not-a-date" },
        // No recurring marker: cannot prove the credits vanish, so it must not
        // drive the rotation.
        { ...pack("2026-11-08", 5, 50), recurring: null },
        pack("2026-11-08", 6, 7),
      ],
    }, NOW);

    expect(bucket).toEqual({ day: "2026-11-08", total: 7, earliestResetAt: Date.parse("2026-11-08T06:00:00.000Z") });
  });

  it("falls back to the ratio when the snapshot carries no absolute amount", () => {
    const bucket = bonusBucketOf({
      routingWindows: [{ ...pack("2026-11-08", 1, 0), ratio: 0.5, remaining: null }],
    }, NOW);

    // Observable but unquantified: it still claims its day so the account is not
    // silently ranked as holding nothing, while contributing 0 to the total.
    expect(bucket).toEqual({ day: "2026-11-08", total: 0, earliestResetAt: Date.parse("2026-11-08T01:00:00.000Z") });
  });

  it("fails open to null for missing or malformed profiles", () => {
    expect(bonusBucketOf(null, NOW)).toBeNull();
    expect(bonusBucketOf({}, NOW)).toBeNull();
    expect(bonusBucketOf({ routingWindows: [] }, NOW)).toBeNull();
    expect(bonusBucketOf({ routingWindows: "nope" }, NOW)).toBeNull();
  });
});

describe("compareBonusRotation", () => {
  const tieMs = QUOTA_SELECTION_DEFAULTS.bonusExpiryTieMs;

  it("gives the turn to the larger credit total first", () => {
    // Ranking, not filtering: the caller walks this order round-robin, so the
    // biggest budget takes the first turn of each cycle without absorbing every
    // request.
    expect(compareBonusRotation({ total: 205 }, { total: 104 })).toBe(-1);
    expect(compareBonusRotation({ total: 104 }, { total: 205 })).toBe(1);
  });

  it("breaks a same-total tie by the exact instant with a 1s tolerance", () => {
    expect(tieMs).toBe(1_000);
    const early = Date.parse("2026-11-08T18:00:00.000Z");
    expect(compareBonusRotation(
      { total: 100, earliestResetAt: early },
      { total: 100, earliestResetAt: early + tieMs },
    )).toBe(0);
    expect(compareBonusRotation(
      { total: 100, earliestResetAt: early },
      { total: 100, earliestResetAt: early + tieMs + 1 },
    )).toBe(-1);
    expect(compareBonusRotation(
      { total: 100, earliestResetAt: early + tieMs + 1 },
      { total: 100, earliestResetAt: early },
    )).toBe(1);
  });

  it("treats a missing bucket or amount as an equal turn", () => {
    // The day gate already excluded these accounts; within a cohort a missing
    // figure must not invent an order, so the caller's stable order stands.
    expect(compareBonusRotation(null, null)).toBe(0);
    expect(compareBonusRotation(undefined, {})).toBe(0);
    expect(compareBonusRotation({ total: 0 }, { total: 0 })).toBe(0);
  });
});

describe("day bucketing end to end", () => {
  it("sums each connection's same-day packs from real-shaped snapshots", () => {
    const profile = profileFor([
      packageRow("one", "monthly", { remaining: 500, limit: 500, resetAt: NOW + 30 * 86_400_000, recurring: true }),
      packageRow("one", "bonus-1", { remaining: 100, limit: 100, resetAt: Date.parse("2026-11-08T18:48:53.000Z") }),
      packageRow("one", "bonus-2", { remaining: 100, limit: 100, resetAt: Date.parse("2026-11-08T22:49:36.000Z") }),
      packageRow("one", "bonus-3", { remaining: 5, limit: 10, resetAt: Date.parse("2026-11-08T22:49:36.000Z") }),
      packageRow("one", "bonus-4", { remaining: 99, limit: 100, resetAt: Date.parse("2026-11-09T19:00:00.000Z") }),
    ]);

    expect(bonusBucketOf(profile, NOW)).toEqual({
      day: "2026-11-08",
      total: 205,
      earliestResetAt: Date.parse("2026-11-08T18:48:53.000Z"),
    });
  });
});
