import { describe, expect, it } from "vitest";
import { projectInventory } from "./projection.js";

const rev = (effectiveDate: string, pillsPerPackage: number, usageMilli: number) => ({
  effectiveDate,
  pillsPerPackage,
  usageMilli,
});
const pkg = (id: string, addedDate: string, createdAt = `${addedDate} 08:00:00`) => ({
  id,
  addedDate,
  createdAt,
});

describe("einpill projection", () => {
  it("projects constant usage in whole UTC calendar days", () => {
    const p = projectInventory(
      [rev("2026-01-01", 30, 1000)],
      [pkg("a", "2026-01-01")],
      "2026-01-02",
    );
    expect(p).toMatchObject({
      state: "active",
      currentPackageId: "a",
      currentStartedDate: "2026-01-01",
      currentRemainingPills: 29,
      sparePackages: 0,
      totalRemainingPills: 29,
      remainingDays: 29,
      runoutDate: "2026-01-31",
    });
  });

  it("uses exact decimal milli-pill arithmetic", () => {
    const p = projectInventory(
      [rev("2026-01-01", 7, 2000)],
      [pkg("a", "2026-01-01")],
      "2026-01-04",
    );
    expect(p.currentRemainingPills).toBe(1);
    expect(p.remainingDays).toBe(1);
    expect(p.runoutDate).toBe("2026-01-05");
  });

  it("keeps deterministic same-date order and counts unopened spares", () => {
    const p = projectInventory(
      [rev("2026-01-01", 2, 1000)],
      [
        pkg("first", "2026-01-01", "2026-01-01 08:00:00"),
        pkg("spare", "2026-01-01", "2026-01-01 08:01:00"),
      ],
      "2026-01-02",
    );
    // The first two-pill package is current; the later two-pill package is still unopened.
    expect(p.currentPackageId).toBe("first");
    expect(p.currentRemainingPills).toBe(1);
    expect(p.sparePackages).toBe(1);
    expect(p.totalRemainingPills).toBe(3);
    expect(p.runoutDate).toBe("2026-01-05");
  });

  it("starts a later package on its addition date after a stock gap", () => {
    const p = projectInventory(
      [rev("2026-01-01", 2, 1000)],
      [pkg("a", "2026-01-01"), pkg("b", "2026-01-10")],
      "2026-01-11",
    );
    expect(p.currentPackageId).toBe("b");
    expect(p.currentStartedDate).toBe("2026-01-10");
    expect(p.currentRemainingPills).toBe(1);
    expect(p.runoutDate).toBe("2026-01-12");
  });

  it("applies usage revisions piecewise by consumption date", () => {
    const p = projectInventory(
      [rev("2026-01-01", 10, 1000), rev("2026-01-03", 10, 2000)],
      [pkg("a", "2026-01-01")],
      "2026-01-04",
    );
    expect(p.currentRemainingPills).toBe(6);
    expect(p.runoutDate).toBe("2026-01-07");
  });

  it("applies package-format revisions by package addition date", () => {
    const p = projectInventory(
      [rev("2026-01-01", 10, 1000), rev("2026-01-05", 20, 1000)],
      [pkg("old", "2026-01-04"), pkg("new", "2026-01-06")],
      "2026-01-04",
    );
    expect(p.totalRemainingPills).toBe(30);
    expect(p.runoutDate).toBe("2026-02-03");
  });

  it("includes future usage revisions in the projected runout", () => {
    const p = projectInventory(
      [rev("2026-01-01", 30, 1000), rev("2026-01-10", 30, 2000)],
      [pkg("a", "2026-01-01")],
      "2026-01-01",
    );
    expect(p.runoutDate).toBe("2026-01-21");
    expect(p.remainingDays).toBe(20);
  });

  it("distinguishes untracked and exhausted stock", () => {
    const untracked = projectInventory([rev("2026-01-01", 30, 1000)], [], "2026-01-01");
    expect(untracked).toMatchObject({ state: "untracked", runoutDate: null, remainingDays: 0 });
    const exhausted = projectInventory(
      [rev("2026-01-01", 1, 1000)],
      [pkg("a", "2026-01-01")],
      "2026-01-02",
    );
    expect(exhausted).toMatchObject({
      state: "exhausted",
      runoutDate: "2026-01-02",
      remainingDays: 0,
      totalRemainingPills: 0,
    });
  });
});
