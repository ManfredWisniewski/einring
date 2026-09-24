import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSecretBox } from "./crypto.js";

describe("SecretBox", () => {
  it("round-trips and produces distinct ciphertexts", () => {
    const box = createSecretBox(randomBytes(32).toString("base64"));
    const a = box.seal("app-password");
    const b = box.seal("app-password");
    expect(a).not.toBe(b);
    expect(box.open(a)).toBe("app-password");
    expect(box.open(b)).toBe("app-password");
  });

  it("rejects tampered data and wrong keys", () => {
    const box = createSecretBox(randomBytes(32).toString("base64"));
    const sealed = box.seal("secret");
    const tampered = Buffer.from(sealed, "base64");
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    expect(() => box.open(tampered.toString("base64"))).toThrow();
    expect(() => createSecretBox(randomBytes(32).toString("base64")).open(sealed)).toThrow();
    expect(() => createSecretBox(randomBytes(16).toString("base64"))).toThrow();
  });
});
