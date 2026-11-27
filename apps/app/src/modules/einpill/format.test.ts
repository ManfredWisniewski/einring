import { describe, expect, it } from "vitest";
import { formatDate, formatPills, validDailyUsage, validPillsPerPackage } from "./format";

describe("einpill formatting", () => {
  it("formats decimal pills with at most three places", () => {
    expect(formatPills(1.5, "en")).toBe("1.5");
    expect(formatPills(2, "en")).toBe("2");
  });

  it("formats UTC calendar dates and nulls", () => {
    expect(formatDate("2026-01-02", "en")).toContain("2026");
    expect(formatDate(null, "en")).toBe("—");
  });

  it("validates bounded dosage input", () => {
    expect(validDailyUsage(0.5)).toBe(true);
    expect(validDailyUsage(1.005)).toBe(true);
    expect(validDailyUsage(0)).toBe(false);
    expect(validDailyUsage(101)).toBe(false);
    expect(validDailyUsage(1.0001)).toBe(false);
    expect(validPillsPerPackage(1)).toBe(true);
    expect(validPillsPerPackage(10_000)).toBe(true);
    expect(validPillsPerPackage(0)).toBe(false);
    expect(validPillsPerPackage(1.5)).toBe(false);
  });
});
