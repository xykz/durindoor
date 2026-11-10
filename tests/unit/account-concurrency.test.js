import { describe, expect, it } from "vitest";
import {
  MAX_ACCOUNT_CONCURRENCY,
  parseAccountConcurrency,
  accountConcurrencyKey,
  resolveConcurrencyGate
} from "../../src/shared/utils/accountConcurrency.js";
import { acquireSlot, releaseSlot, getConcurrencyLimit, getGateStats, _resetGates } from "../../open-sse/services/concurrencyGate.js";

const gateOf = (overrides = {}) => resolveConcurrencyGate({
  provider: "codebuddy-cn",
  connectionId: "conn-a",
  providerConcurrencyLimit: {},
  accountConcurrencyLimit: 0,
  providerLimitOf: getConcurrencyLimit,
  ...overrides
});

describe("parseAccountConcurrency", () => {
  it("accepts a positive integer header value", () => {
    expect(parseAccountConcurrency("3")).toBe(3);
    expect(parseAccountConcurrency("1")).toBe(1);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseAccountConcurrency(" 3 ")).toBe(3);
    expect(parseAccountConcurrency("\t5\n")).toBe(5);
    expect(parseAccountConcurrency("  10  ")).toBe(10);
  });

  it("accepts a numeric header value", () => {
    expect(parseAccountConcurrency(3)).toBe(3);
    expect(parseAccountConcurrency(1)).toBe(1);
  });

  it("clamps above the safety ceiling", () => {
    expect(parseAccountConcurrency(String(MAX_ACCOUNT_CONCURRENCY))).toBe(MAX_ACCOUNT_CONCURRENCY);
    expect(parseAccountConcurrency(String(MAX_ACCOUNT_CONCURRENCY + 1))).toBe(MAX_ACCOUNT_CONCURRENCY);
    expect(parseAccountConcurrency("999")).toBe(MAX_ACCOUNT_CONCURRENCY);
    expect(parseAccountConcurrency(5000)).toBe(MAX_ACCOUNT_CONCURRENCY);
  });

  it("returns null for zero, negative, and fractional values", () => {
    expect(parseAccountConcurrency("0")).toBeNull();
    expect(parseAccountConcurrency(0)).toBeNull();
    expect(parseAccountConcurrency("-1")).toBeNull();
    expect(parseAccountConcurrency(-1)).toBeNull();
    expect(parseAccountConcurrency("1.5")).toBeNull();
    expect(parseAccountConcurrency(1.5)).toBeNull();
    expect(parseAccountConcurrency("0.5")).toBeNull();
  });

  it("returns null for blank, malformed, or non-numeric values", () => {
    expect(parseAccountConcurrency(undefined)).toBeNull();
    expect(parseAccountConcurrency(null)).toBeNull();
    expect(parseAccountConcurrency("")).toBeNull();
    expect(parseAccountConcurrency("   ")).toBeNull();
    expect(parseAccountConcurrency("abc")).toBeNull();
    expect(parseAccountConcurrency("3x")).toBeNull();
    expect(parseAccountConcurrency("3,4")).toBeNull();
    expect(parseAccountConcurrency("0x10")).toBeNull();
    expect(parseAccountConcurrency("1e3")).toBeNull();
    expect(parseAccountConcurrency(NaN)).toBeNull();
    expect(parseAccountConcurrency(Infinity)).toBeNull();
    expect(parseAccountConcurrency({ limit: 3 })).toBeNull();
    expect(parseAccountConcurrency([3])).toBeNull();
  });

  it("returns null for the literal 'infinity'/'off' spellings", () => {
    expect(parseAccountConcurrency("infinity")).toBeNull();
    expect(parseAccountConcurrency("off")).toBeNull();
    expect(parseAccountConcurrency("none")).toBeNull();
  });
});

describe("accountConcurrencyKey", () => {
  it("composes provider and connection id", () => {
    expect(accountConcurrencyKey("codebuddy-cn", "abc123")).toBe("codebuddy-cn:abc123");
  });

  it("cannot collide with a bare provider gate key", () => {
    expect(accountConcurrencyKey("codebuddy-cn", "x")).not.toBe("codebuddy-cn");
  });

  it("returns null when either part is missing or blank", () => {
    expect(accountConcurrencyKey(null, "abc")).toBeNull();
    expect(accountConcurrencyKey("codebuddy-cn", null)).toBeNull();
    expect(accountConcurrencyKey("codebuddy-cn", undefined)).toBeNull();
    expect(accountConcurrencyKey("", "abc")).toBeNull();
    expect(accountConcurrencyKey("codebuddy-cn", "")).toBeNull();
    expect(accountConcurrencyKey(1, "abc")).toBeNull();
    expect(accountConcurrencyKey("codebuddy-cn", 7)).toBeNull();
  });
});

describe("resolveConcurrencyGate", () => {
  it("uses the account key when a per-account cap is requested", () => {
    expect(gateOf({ accountConcurrencyLimit: 3 })).toEqual({
      key: "codebuddy-cn:conn-a",
      limit: 3,
      scope: "account"
    });
  });

  it("keeps the provider key when no per-account cap is requested", () => {
    expect(gateOf({ providerConcurrencyLimit: { "codebuddy-cn": 2 } })).toEqual({
      key: "codebuddy-cn",
      limit: 2,
      scope: "provider"
    });
  });

  it("leaves the provider gate unlimited when nothing is configured", () => {
    expect(gateOf()).toEqual({ key: "codebuddy-cn", limit: 0, scope: "provider" });
  });

  it("supersedes the provider-wide limit instead of stacking with it", () => {
    // Max Concurrent = 3 stays in settings, but the header raises the ceiling
    // for the selected account; stacking would clamp the pool back to 3.
    const gate = gateOf({ accountConcurrencyLimit: 3, providerConcurrencyLimit: { "codebuddy-cn": 1 } });
    expect(gate.scope).toBe("account");
    expect(gate.limit).toBe(3);
    expect(gate.key).not.toBe("codebuddy-cn");
  });

  it("falls back to the provider gate when the connection id is unknown", () => {
    expect(gateOf({ accountConcurrencyLimit: 3, connectionId: null, providerConcurrencyLimit: { "codebuddy-cn": 2 } })).toEqual({
      key: "codebuddy-cn",
      limit: 2,
      scope: "provider"
    });
  });

  it("treats a zero per-account cap as absent", () => {
    expect(gateOf({ accountConcurrencyLimit: 0, providerConcurrencyLimit: { "codebuddy-cn": 4 } })).toEqual({
      key: "codebuddy-cn",
      limit: 4,
      scope: "provider"
    });
  });

  it("gives distinct accounts distinct gates", () => {
    const a = gateOf({ accountConcurrencyLimit: 3, connectionId: "conn-a" });
    const b = gateOf({ accountConcurrencyLimit: 3, connectionId: "conn-b" });
    expect(a.key).toBe("codebuddy-cn:conn-a");
    expect(b.key).toBe("codebuddy-cn:conn-b");
    expect(a.key).not.toBe(b.key);
  });
});

describe("account gate isolation on the real semaphore", () => {
  it("keeps per-account slots independent and releases the composite key", async () => {
    _resetGates();
    const keyA = accountConcurrencyKey("codebuddy-cn", "conn-a");
    const keyB = accountConcurrencyKey("codebuddy-cn", "conn-b");

    await acquireSlot(keyA, 2);
    await acquireSlot(keyA, 2);
    await acquireSlot(keyB, 2);

    expect(getGateStats()[keyA].current).toBe(2);
    expect(getGateStats()[keyB].current).toBe(1);

    // Releasing conn-a must not disturb conn-b, and must fully drain conn-a.
    releaseSlot(keyA);
    releaseSlot(keyA);
    expect(getGateStats()[keyA]).toBeUndefined();
    expect(getGateStats()[keyB].current).toBe(1);

    releaseSlot(keyB);
    expect(getGateStats()).toEqual({});
  });

  it("blocks above the per-account limit while another account stays free", async () => {
    _resetGates();
    const keyA = accountConcurrencyKey("codebuddy-cn", "conn-a");
    const keyB = accountConcurrencyKey("codebuddy-cn", "conn-b");

    await acquireSlot(keyA, 1);

    let ranOnA = false;
    const pending = acquireSlot(keyA, 1, 30).then(() => { ranOnA = true; }).catch(() => { });
    // conn-b is a different gate and admits immediately.
    await expect(acquireSlot(keyB, 1)).resolves.toBeUndefined();
    await pending;
    expect(ranOnA).toBe(false);

    releaseSlot(keyA);
    releaseSlot(keyB);
    expect(getGateStats()).toEqual({});
  });

  it("has no gate at all when neither header nor settings configure one", async () => {
    _resetGates();
    const gate = gateOf();
    expect(gate.limit).toBe(0);
    // limit 0 is the documented "unlimited" path: acquireSlot resolves at once.
    await expect(acquireSlot(gate.key, gate.limit)).resolves.toBeUndefined();
    expect(getGateStats()).toEqual({});
  });
});
