import { describe, expect, it } from "vitest";
import { checkResourceSize, RESOURCE_BUDGETS } from "./resource-budgets.mjs";

describe("release resource budgets", () => {
  for (const [kind, ceiling] of Object.entries(RESOURCE_BUDGETS)) {
    it(`accepts the exact ${kind} ceiling and rejects growth above it`, () => {
      expect(() => checkResourceSize(kind, ceiling)).not.toThrow();
      expect(() => checkResourceSize(kind, ceiling + 1)).toThrow("Review the growth; do not trim the catalogue");
    });
  }
  it("rejects invalid measurements and unknown budgets", () => {
    for (const value of [-1, NaN, Infinity, 1.5]) {
      expect(() => checkResourceSize("catalogueGzipBytes", value)).toThrow("Invalid resource size");
    }
    expect(() => checkResourceSize("unknown", 1)).toThrow("Unknown resource budget");
  });
});
