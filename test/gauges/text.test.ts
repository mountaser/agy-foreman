import { describe, it, expect } from "vitest";
import { MANUAL, PROMPT, parseChoice } from "../../src/gauges/text.js";

describe("parseChoice", () => {
  it("accepts numbers, letters and words in any case", () => {
    for (const a of ["1", "i", "I", " install ", "INSTALL"]) expect(parseChoice(a)).toBe("install");
    for (const a of ["2", "m", "manual"]) expect(parseChoice(a)).toBe("manual");
    for (const a of ["3", "s", "skip", "", "  "]) expect(parseChoice(a)).toBe("skip");
  });

  it("rejects anything else", () => {
    for (const a of ["4", "yes", "0", "installx"]) expect(parseChoice(a)).toBeUndefined();
  });
});

describe("texts", () => {
  it("show the three options", () => {
    expect(PROMPT).toContain("[1] Install claude-gauges");
    expect(PROMPT).toContain("[2] I will do it myself");
    expect(PROMPT).toContain("[3] Skip");
  });

  it("print both install commands", () => {
    expect(MANUAL).toContain(
      "curl -fsSL https://raw.githubusercontent.com/mountaser/claude-gauges/main/install.sh | bash",
    );
    expect(MANUAL).toContain(
      "irm https://raw.githubusercontent.com/mountaser/claude-gauges/main/install.ps1 | iex",
    );
  });
});
