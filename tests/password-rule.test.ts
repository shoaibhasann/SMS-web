// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MAX_PASSWORD_BYTES, MIN_PASSWORD_LENGTH, passwordProblem } from "@/lib/account/password-rule";

describe("the one password length rule", () => {
  it("is 8 characters minimum and 72 UTF-8 bytes maximum", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
    expect(MAX_PASSWORD_BYTES).toBe(72);
  });
  it.each([
    ["7 code points", "abcdefg", "too_short"],
    ["8 code points", "abcdefgh", null],
    ["empty", "", "too_short"],
    ["whitespace only", " ".repeat(8), "too_short"],
    ["whitespace only, long", " \t".repeat(10), "too_short"],
    ["8 emoji count as 8", "😀".repeat(8), null],
    ["7 emoji are 14 UTF-16 units but 7 characters", "😀".repeat(7), "too_short"],
    ["72 bytes", "x".repeat(72), null],
    ["73 bytes", "x".repeat(73), "too_long"],
    ["18 emoji are 72 bytes", "😀".repeat(18), null],
    ["19 emoji are 76 bytes", "😀".repeat(19), "too_long"],
  ])("%s", (_name, password, problem) => {
    expect(passwordProblem(password)).toBe(problem);
  });
});
