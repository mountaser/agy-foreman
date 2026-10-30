import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Fetch } from "../../src/gauges/download.js";
import { installGauges, type InstallGaugesDeps } from "../../src/gauges/install.js";
import {
  claudeSettingsPath,
  currentStatusLineCommand,
  isOldForemanCommand,
} from "../../src/gauges/settings.js";

const ASSET = "claude-gauges_linux_amd64";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function fakeFetch(files: Record<string, string>): { fetch: Fetch; urls: string[] } {
  const urls: string[] = [];
  const fetch: Fetch = async (url) => {
    urls.push(url);
    const body = files[url];
    return {
      ok: body !== undefined,
      status: body !== undefined ? 200 : 404,
      arrayBuffer: async () => new TextEncoder().encode(body ?? "").buffer as ArrayBuffer,
      text: async () => body ?? "",
    };
  };
  return { fetch, urls };
}

function setup(over: Partial<InstallGaugesDeps> = {}, body = "binary") {
  const base = "https://github.com/mountaser/claude-gauges/releases/latest/download";
  const f = fakeFetch({
    [`${base}/checksums.txt`]: `${sha("binary")}  ${ASSET}\n`,
    [`${base}/${ASSET}`]: body,
  });
  const out: string[] = [];
  const err: string[] = [];
  const runs: { exe: string; args: string[] }[] = [];
  const removed: string[] = [];
  const dir = mkdtempSync(path.join(os.tmpdir(), "foreman-gi-"));
  const deps: InstallGaugesDeps = {
    fetch: f.fetch,
    platform: "linux",
    arch: "x64",
    mkTmp: async () => dir,
    rmTmp: async (d) => {
      removed.push(d);
      rmSync(d, { recursive: true, force: true });
    },
    run: async (exe, args) => {
      runs.push({ exe, args });
      return 0;
    },
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    ...over,
  };
  return { deps, out, err, runs, removed, dir, urls: f.urls };
}

describe("installGauges", () => {
  it("downloads, verifies and runs the installer, then cleans up", async () => {
    const s = setup();
    expect(await installGauges(s.deps, { force: false })).toBe(0);
    expect(s.runs).toHaveLength(1);
    expect(path.basename(s.runs[0].exe)).toBe("claude-gauges");
    expect(s.runs[0].args).toEqual(["install"]);
    expect(s.removed).toEqual([s.dir]);
    expect(s.out.join("\n")).toContain(`Downloading ${ASSET}`);
  });

  it("returns the exit code of the installer", async () => {
    const s = setup({ run: async () => 7 });
    expect(await installGauges(s.deps, { force: false })).toBe(7);
  });

  it("passes --force on", async () => {
    const s = setup();
    await installGauges(s.deps, { force: true });
    expect(s.runs[0].args).toEqual(["install", "--force"]);
  });

  it("replaces the old agy-foreman status line without being asked", async () => {
    const s = setup({ currentCommand: 'node "C:/x/agy-foreman/dist/statusline.js"' });
    await installGauges(s.deps, { force: false });
    expect(s.runs[0].args).toEqual(["install", "--force"]);
    expect(s.out.join("\n")).toContain("Replacing the old agy-foreman status line");
  });

  it("does not force over some other status line", async () => {
    const s = setup({ currentCommand: "my-own-statusline.sh --fancy" });
    await installGauges(s.deps, { force: false });
    expect(s.runs[0].args).toEqual(["install"]);
  });

  it("uses a pinned version", async () => {
    const base = "https://github.com/mountaser/claude-gauges/releases/download/v0.2.3";
    const f = fakeFetch({
      [`${base}/checksums.txt`]: `${sha("binary")}  ${ASSET}\n`,
      [`${base}/${ASSET}`]: "binary",
    });
    const s = setup({ fetch: f.fetch });
    expect(await installGauges(s.deps, { force: false, version: "v0.2.3" })).toBe(0);
    expect(f.urls.every((u) => u.includes("/download/v0.2.3/"))).toBe(true);
  });

  it("stops before downloading on a system without a build", async () => {
    const s = setup({ platform: "freebsd" });
    expect(await installGauges(s.deps, { force: false })).toBe(1);
    expect(s.urls).toEqual([]);
    expect(s.err.join("\n")).toContain("agy-foreman statusline --manual");
  });

  it("runs nothing when the checksum is wrong, and still cleans up", async () => {
    const s = setup({}, "tampered");
    expect(await installGauges(s.deps, { force: false })).toBe(1);
    expect(s.runs).toEqual([]);
    expect(s.err.join("\n")).toContain("checksum mismatch");
    expect(s.removed).toEqual([s.dir]);
  });
});

describe("settings helpers", () => {
  it("finds the settings file", () => {
    expect(claudeSettingsPath({ FOREMAN_CLAUDE_SETTINGS: "/x/s.json" })).toBe("/x/s.json");
    expect(claudeSettingsPath({ HOME: "/home/a" })).toBe(
      path.join("/home/a", ".claude", "settings.json"),
    );
  });

  it("reads the status line command, ignoring a byte order mark", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "foreman-gs-"));
    const file = path.join(dir, "settings.json");
    writeFileSync(file, "\uFEFF" + JSON.stringify({ statusLine: { command: "x.exe" } }));
    expect(await currentStatusLineCommand(file)).toBe("x.exe");
    writeFileSync(file, "{}");
    expect(await currentStatusLineCommand(file)).toBeUndefined();
    writeFileSync(file, "not json");
    expect(await currentStatusLineCommand(file)).toBeUndefined();
    expect(await currentStatusLineCommand(path.join(dir, "missing.json"))).toBeUndefined();
  });

  it("recognises the command older agy-foreman versions installed", () => {
    expect(isOldForemanCommand('node "C:/Users/a/agy-foreman/dist/statusline.js"')).toBe(true);
    expect(isOldForemanCommand("node /x/index.js statusline")).toBe(true);
    expect(isOldForemanCommand("C:/Users/a/.claude/claude-gauges.exe")).toBe(false);
    expect(isOldForemanCommand(undefined)).toBe(false);
  });
});
