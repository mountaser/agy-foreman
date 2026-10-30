import { describe, it, expect } from "vitest";
import { statusFile } from "../src/paths.js";

describe("statusFile", () => {
  it("puts status.json in the state dir on every platform", () => {
    expect(
      statusFile({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" },
        home: "C:\\Users\\a",
      }),
    ).toBe("C:\\Users\\a\\AppData\\Local\\agy-foreman\\status.json");
    expect(statusFile({ platform: "linux", env: { XDG_STATE_HOME: "/s" }, home: "/h" })).toBe(
      "/s/agy-foreman/status.json",
    );
    expect(statusFile({ platform: "darwin", env: {}, home: "/Users/a" })).toBe(
      "/Users/a/Library/Application Support/agy-foreman/status.json",
    );
  });

  it("follows FOREMAN_STATE_DIR", () => {
    expect(statusFile({ platform: "linux", env: { FOREMAN_STATE_DIR: "/x" }, home: "/h" })).toBe(
      "/x/status.json",
    );
  });
});
