import { describe, expect, it } from "vitest";
import { parseAccountStrategy, isRoundRobinStrategy } from "../../src/shared/utils/accountStrategy.js";

describe("parseAccountStrategy", () => {
  it("accepts the known per-request strategies", () => {
    expect(parseAccountStrategy("bonus-first")).toBe("bonus-first");
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(parseAccountStrategy("  BONUS-FIRST ")).toBe("bonus-first");
    expect(parseAccountStrategy("Bonus-First")).toBe("bonus-first");
  });

  it("returns null for blank, unknown, or non-string values", () => {
    expect(parseAccountStrategy(undefined)).toBeNull();
    expect(parseAccountStrategy(null)).toBeNull();
    expect(parseAccountStrategy("")).toBeNull();
    expect(parseAccountStrategy("   ")).toBeNull();
    expect(parseAccountStrategy("bonus")).toBeNull();
    expect(parseAccountStrategy("fill-first")).toBeNull();
    expect(parseAccountStrategy("round-robin")).toBeNull();
    expect(parseAccountStrategy(1)).toBeNull();
    expect(parseAccountStrategy({ strategy: "bonus-first" })).toBeNull();
  });
});

describe("isRoundRobinStrategy", () => {
  it("treats bonus-first as a round-robin variant", () => {
    expect(isRoundRobinStrategy("round-robin")).toBe(true);
    expect(isRoundRobinStrategy("bonus-first")).toBe(true);
  });

  it("excludes fill-first, blank, and unknown values", () => {
    expect(isRoundRobinStrategy("fill-first")).toBe(false);
    expect(isRoundRobinStrategy("")).toBe(false);
    expect(isRoundRobinStrategy(null)).toBe(false);
    expect(isRoundRobinStrategy(undefined)).toBe(false);
    expect(isRoundRobinStrategy("nope")).toBe(false);
  });
});
