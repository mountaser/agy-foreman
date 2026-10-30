import { describe, it, expect } from "vitest";
import { assetName, parseChecksum, releaseBase } from "../../src/gauges/asset.js";

describe("assetName", () => {
  it("names the release file for each supported system", () => {
    expect(assetName("linux", "x64")).toBe("claude-gauges_linux_amd64");
    expect(assetName("linux", "arm64")).toBe("claude-gauges_linux_arm64");
    expect(assetName("darwin", "x64")).toBe("claude-gauges_darwin_amd64");
    expect(assetName("darwin", "arm64")).toBe("claude-gauges_darwin_arm64");
    expect(assetName("win32", "x64")).toBe("claude-gauges_windows_amd64.exe");
    expect(assetName("win32", "arm64")).toBe("claude-gauges_windows_arm64.exe");
  });

  it("returns undefined for systems without a build", () => {
    expect(assetName("freebsd", "x64")).toBeUndefined();
    expect(assetName("linux", "ia32")).toBeUndefined();
    expect(assetName("win32", "arm")).toBeUndefined();
  });
});

describe("releaseBase", () => {
  it("points at the latest release unless a version is given", () => {
    expect(releaseBase()).toBe(
      "https://github.com/mountaser/claude-gauges/releases/latest/download",
    );
    expect(releaseBase("v0.2.3")).toBe(
      "https://github.com/mountaser/claude-gauges/releases/download/v0.2.3",
    );
  });
});

describe("parseChecksum", () => {
  const a = "a".repeat(64);
  const b = "B".repeat(64);
  it("finds the line of one file", () => {
    const text = `${a}  claude-gauges_linux_amd64\n${b}  claude-gauges_windows_amd64.exe\n`;
    expect(parseChecksum(text, "claude-gauges_linux_amd64")).toBe(a);
    expect(parseChecksum(text, "claude-gauges_windows_amd64.exe")).toBe("b".repeat(64));
  });

  it("accepts a leading star and Windows line endings", () => {
    expect(parseChecksum(`${a} *claude-gauges_linux_amd64\r\n`, "claude-gauges_linux_amd64")).toBe(
      a,
    );
  });

  it("does not match a longer name or a bad hash", () => {
    expect(
      parseChecksum(`${a}  claude-gauges_linux_amd64.sig\n`, "claude-gauges_linux_amd64"),
    ).toBeUndefined();
    expect(
      parseChecksum("abc  claude-gauges_linux_amd64\n", "claude-gauges_linux_amd64"),
    ).toBeUndefined();
    expect(parseChecksum("", "claude-gauges_linux_amd64")).toBeUndefined();
  });
});
