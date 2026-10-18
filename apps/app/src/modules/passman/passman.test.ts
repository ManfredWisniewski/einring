import { describe, expect, it } from "vitest";
import { passmanTags } from "./PassmanPage";

describe("passmanTags", () => {
  it("normalizes every observed Passman tag shape", () => {
    expect(passmanTags([{ text: "a" }, { text: "b" }])).toEqual(["a", "b"]);
    // PHP assoc-array serialization: single tag / non-sequential indices → object.
    expect(passmanTags({ text: "solo" })).toEqual(["solo"]);
    expect(passmanTags({ "0": { text: "a" }, "2": { text: "b" } })).toEqual(["a", "b"]);
    // JSON string variants.
    expect(passmanTags('[{"text":"x"}]')).toEqual(["x"]);
    expect(passmanTags("plain")).toEqual(["plain"]);
    // Plain strings mixed into the array.
    expect(passmanTags(["a", { text: "b" }])).toEqual(["a", "b"]);
    expect(passmanTags(undefined)).toEqual([]);
    expect(passmanTags({})).toEqual([]);
    expect(passmanTags([])).toEqual([]);
  });
});
