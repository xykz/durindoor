import { describe, expect, it } from "vitest";
import { parseTokenBudget } from "../../src/shared/utils/tokenBudget.js";

describe("parseTokenBudget", () => {
  it("returns null for blank or malformed values", () => {
    expect(parseTokenBudget(undefined)).toBeNull();
    expect(parseTokenBudget(null)).toBeNull();
    expect(parseTokenBudget("")).toBeNull();
    expect(parseTokenBudget("   ")).toBeNull();
    expect(parseTokenBudget("lots")).toBeNull();
    expect(parseTokenBudget("-5")).toBeNull();
    expect(parseTokenBudget("0")).toBeNull();
    expect(parseTokenBudget(-1)).toBeNull();
  });

  it("parses a bare integer as a token count", () => {
    expect(parseTokenBudget("180000000")).toBe(180_000_000);
    expect(parseTokenBudget(180_000_000)).toBe(180_000_000);
  });

  it("honors k/m/b suffixes", () => {
    expect(parseTokenBudget("180k")).toBe(180_000);
    expect(parseTokenBudget("180m")).toBe(180_000_000);
    expect(parseTokenBudget("1.8b")).toBe(1_800_000_000);
    expect(parseTokenBudget("180 M")).toBe(180_000_000);
  });
});
