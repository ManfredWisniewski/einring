import { describe, expect, it } from "vitest";
import { formatDuration, parseDurationMinutes } from "./duration";

describe("parseDurationMinutes (spec eintime FR-008)", () => {
  it("parses all owner-listed forms identically", () => {
    expect(parseDurationMinutes("2")).toBe(120);
    expect(parseDurationMinutes("2.5")).toBe(150);
    expect(parseDurationMinutes("2h 30min")).toBe(150);
    expect(parseDurationMinutes("1:30")).toBe(90);
    expect(parseDurationMinutes("90m")).toBe(90);
    expect(parseDurationMinutes("2:30")).toBe(150);
  });

  it("accepts further spellings", () => {
    expect(parseDurationMinutes("1h")).toBe(60);
    expect(parseDurationMinutes("1h15m")).toBe(75);
    expect(parseDurationMinutes("2 h")).toBe(120);
    expect(parseDurationMinutes("45min")).toBe(45);
    expect(parseDurationMinutes("1.5h")).toBe(90);
    expect(parseDurationMinutes("0:45")).toBe(45);
    expect(parseDurationMinutes("2,5")).toBe(150);
  });

  it("rejects junk", () => {
    expect(parseDurationMinutes("")).toBeNull();
    expect(parseDurationMinutes("abc")).toBeNull();
    expect(parseDurationMinutes("1:75")).toBeNull();
    expect(parseDurationMinutes("2h 30x")).toBeNull();
    expect(parseDurationMinutes("-1")).toBeNull();
  });
});

describe("formatDuration", () => {
  it("renders h:mm", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(90)).toBe("1:30");
    expect(formatDuration(150)).toBe("2:30");
  });
});
