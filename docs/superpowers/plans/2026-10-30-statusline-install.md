# Status Line Install Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace agy-foreman's own status line with a prompt that installs claude-gauges, as specified in `docs/superpowers/specs/2026-10-30-statusline-install-design.md`.

**Architecture:** Small pure modules under `src/gauges/` pick the release file, parse the checksum list and hold the prompt text. A download module fetches and verifies a release file with an injected `fetch`. An installer module ties them together with injected side effects (temp folder, running the program). `cli.ts` gets the new `statusline` command and loses the old renderer.

**Tech Stack:** TypeScript (strict, ESM), Node 20+ (global `fetch`), vitest, prettier. No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-10-30-statusline-install-design.md`. Behavior there is authoritative.
- ESM imports use the `.js` suffix. Type-only imports use `import type`.
- Format with `npx prettier --write src test` (print width 100). `npm run test:ci` must pass before every commit.
- No new dependencies. Network access only through an injected `fetch`; only `https://github.com/mountaser/claude-gauges/releases/...` is ever requested.
- Tests never touch the network, the user's real settings or the real home folder.
- Run every command in Git Bash.
- Commit after every task. Do not push.

## File Structure

```
src/gauges/asset.ts          assetName, releaseBase, parseChecksum
src/gauges/text.ts           PROMPT, MANUAL, Choice, parseChoice
src/gauges/download.ts       Fetch type, downloadVerified
src/gauges/settings.ts       claudeSettingsPath, currentStatusLineCommand, isOldForemanCommand
src/gauges/install.ts        installGauges
src/statusline-stub.ts       prints nothing (keeps old settings working)
src/cli.ts                   new statusline command, init hint; old renderer removed
src/index.ts                 terminal question support
test/gauges/*.test.ts        one test file per module
test/cli.test.ts             statusline and init tests added
```

Deleted: `src/statusline.ts`, `src/statusline-main.ts`, `test/statusline.test.ts`.

---

### Task 1: Release file names, checksum parsing and prompt text

**Files:**
- Create: `src/gauges/asset.ts`, `src/gauges/text.ts`
- Test: `test/gauges/asset.test.ts`, `test/gauges/text.test.ts`

**Interfaces:**
- Produces:
  - `assetName(platform: NodeJS.Platform, arch: string): string | undefined`
  - `releaseBase(version?: string): string`
  - `parseChecksum(text: string, asset: string): string | undefined` (lower-case hex)
  - `PROMPT: string`, `MANUAL: string`, `type Choice = "install" | "manual" | "skip"`, `parseChoice(answer: string): Choice | undefined`

- [ ] **Step 1: Write the failing tests**

`test/gauges/asset.test.ts`:
```ts
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
    expect(releaseBase()).toBe("https://github.com/mountaser/claude-gauges/releases/latest/download");
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
    expect(parseChecksum(`${a} *claude-gauges_linux_amd64\r\n`, "claude-gauges_linux_amd64")).toBe(a);
  });

  it("does not match a longer name or a bad hash", () => {
    expect(parseChecksum(`${a}  claude-gauges_linux_amd64.sig\n`, "claude-gauges_linux_amd64")).toBeUndefined();
    expect(parseChecksum("abc  claude-gauges_linux_amd64\n", "claude-gauges_linux_amd64")).toBeUndefined();
    expect(parseChecksum("", "claude-gauges_linux_amd64")).toBeUndefined();
  });
});
```

`test/gauges/text.test.ts`:
```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/gauges/asset.test.ts test/gauges/text.test.ts`
Expected: FAIL (cannot find modules `../../src/gauges/asset.js` and `../../src/gauges/text.js`)

- [ ] **Step 3: Write the implementation**

`src/gauges/asset.ts`:
```ts
export const GAUGES_REPO = "mountaser/claude-gauges";

/** The release file for a platform and CPU as Node names them, or undefined when there is none. */
export function assetName(platform: NodeJS.Platform, arch: string): string | undefined {
  const os =
    platform === "win32"
      ? "windows"
      : platform === "darwin"
        ? "darwin"
        : platform === "linux"
          ? "linux"
          : undefined;
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : undefined;
  if (!os || !cpu) return undefined;
  return `claude-gauges_${os}_${cpu}${os === "windows" ? ".exe" : ""}`;
}

/** Where a release's files are downloaded from. The latest release unless a tag is given. */
export function releaseBase(version?: string): string {
  return version
    ? `https://github.com/${GAUGES_REPO}/releases/download/${version}`
    : `https://github.com/${GAUGES_REPO}/releases/latest/download`;
}

/** The SHA-256 of one file from a `checksums.txt` (`<hex>  <name>` per line), lower case. */
export function parseChecksum(text: string, asset: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m && m[2] === asset) return m[1].toLowerCase();
  }
  return undefined;
}
```

`src/gauges/text.ts`:
```ts
export const PROMPT = `Status line

claude-gauges shows your jobs, the Gemini quota, your Claude limits and the cache timer
under the Claude Code prompt.

  [1] Install claude-gauges (downloads the latest release from GitHub and checks its SHA-256)
  [2] I will do it myself (prints the commands)
  [3] Skip
`;

export const MANUAL = `Install claude-gauges yourself:

  macOS, Linux, WSL:   curl -fsSL https://raw.githubusercontent.com/mountaser/claude-gauges/main/install.sh | bash
  Windows PowerShell:  irm https://raw.githubusercontent.com/mountaser/claude-gauges/main/install.ps1 | iex

Then restart Claude Code. More: https://github.com/mountaser/claude-gauges`;

export type Choice = "install" | "manual" | "skip";

/** Reads the answer to the prompt. An empty answer skips; an unknown one is undefined. */
export function parseChoice(answer: string): Choice | undefined {
  switch (answer.trim().toLowerCase()) {
    case "1":
    case "i":
    case "install":
      return "install";
    case "2":
    case "m":
    case "manual":
      return "manual";
    case "3":
    case "s":
    case "skip":
    case "":
      return "skip";
    default:
      return undefined;
  }
}
```

- [ ] **Step 4: Run the tests and the full check**

Run: `npx prettier --write src test && npm run test:ci`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/gauges/asset.ts src/gauges/text.ts test/gauges/asset.test.ts test/gauges/text.test.ts
git commit -m "feat: release file names, checksum parsing and prompt text for claude-gauges"
```

---

### Task 2: Verified download

**Files:**
- Create: `src/gauges/download.ts`
- Test: `test/gauges/download.test.ts`

**Interfaces:**
- Consumes: `parseChecksum` from `src/gauges/asset.ts` (Task 1).
- Produces:
  - `type Fetch = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }>`
  - `downloadVerified(o: { fetch: Fetch; base: string; asset: string; dir: string }): Promise<string>` returns the path of the written file: `<dir>/claude-gauges.exe` for an asset ending in `.exe`, else `<dir>/claude-gauges`, mode 0o755. It throws an `Error` whose message is one of: `could not download checksums.txt (HTTP <status>)`, `no checksum is listed for <asset>`, `could not download <asset> (HTTP <status>)`, `checksum mismatch for <asset> (expected <want>, got <got>)`. It writes nothing unless the checksum matches. A fetch that rejects propagates.

- [ ] **Step 1: Write the failing test**

`test/gauges/download.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { downloadVerified, type Fetch } from "../../src/gauges/download.js";

const BASE = "https://example.test/rel";
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

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "foreman-dl-"));

describe("downloadVerified", () => {
  it("writes the file when the checksum matches", async () => {
    const dir = tmp();
    const { fetch, urls } = fakeFetch({
      [`${BASE}/checksums.txt`]: `${sha("binary")}  claude-gauges_linux_amd64\n`,
      [`${BASE}/claude-gauges_linux_amd64`]: "binary",
    });
    const file = await downloadVerified({ fetch, base: BASE, asset: "claude-gauges_linux_amd64", dir });
    expect(file).toBe(path.join(dir, "claude-gauges"));
    expect(readFileSync(file, "utf8")).toBe("binary");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o111).not.toBe(0);
    expect(urls.every((u) => u.startsWith(BASE + "/"))).toBe(true);
  });

  it("names a Windows file with .exe", async () => {
    const dir = tmp();
    const { fetch } = fakeFetch({
      [`${BASE}/checksums.txt`]: `${sha("w")}  claude-gauges_windows_amd64.exe\n`,
      [`${BASE}/claude-gauges_windows_amd64.exe`]: "w",
    });
    const file = await downloadVerified({ fetch, base: BASE, asset: "claude-gauges_windows_amd64.exe", dir });
    expect(path.basename(file)).toBe("claude-gauges.exe");
  });

  it("refuses a file whose checksum differs and writes nothing", async () => {
    const dir = tmp();
    const { fetch } = fakeFetch({
      [`${BASE}/checksums.txt`]: `${sha("good")}  claude-gauges_linux_amd64\n`,
      [`${BASE}/claude-gauges_linux_amd64`]: "tampered",
    });
    await expect(
      downloadVerified({ fetch, base: BASE, asset: "claude-gauges_linux_amd64", dir }),
    ).rejects.toThrow(/checksum mismatch for claude-gauges_linux_amd64/);
    expect(existsSync(path.join(dir, "claude-gauges"))).toBe(false);
  });

  it("refuses when the checksum list has no line for the file", async () => {
    const { fetch } = fakeFetch({
      [`${BASE}/checksums.txt`]: `${sha("x")}  claude-gauges_darwin_arm64\n`,
      [`${BASE}/claude-gauges_linux_amd64`]: "x",
    });
    await expect(
      downloadVerified({ fetch, base: BASE, asset: "claude-gauges_linux_amd64", dir: tmp() }),
    ).rejects.toThrow("no checksum is listed for claude-gauges_linux_amd64");
  });

  it("reports failed downloads with the HTTP status", async () => {
    const none = fakeFetch({});
    await expect(
      downloadVerified({ fetch: none.fetch, base: BASE, asset: "claude-gauges_linux_amd64", dir: tmp() }),
    ).rejects.toThrow("could not download checksums.txt (HTTP 404)");

    const noBinary = fakeFetch({ [`${BASE}/checksums.txt`]: `${sha("x")}  claude-gauges_linux_amd64\n` });
    await expect(
      downloadVerified({ fetch: noBinary.fetch, base: BASE, asset: "claude-gauges_linux_amd64", dir: tmp() }),
    ).rejects.toThrow("could not download claude-gauges_linux_amd64 (HTTP 404)");
  });

  it("lets a failing fetch through", async () => {
    const fetch: Fetch = async () => {
      throw new Error("offline");
    };
    await expect(
      downloadVerified({ fetch, base: BASE, asset: "claude-gauges_linux_amd64", dir: tmp() }),
    ).rejects.toThrow("offline");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/gauges/download.test.ts`
Expected: FAIL (cannot find module `../../src/gauges/download.js`)

- [ ] **Step 3: Write the implementation**

`src/gauges/download.ts`:
```ts
import { createHash } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseChecksum } from "./asset.js";

/** The part of `fetch` this module uses, so tests can replace it. */
export type Fetch = (url: string) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;

/**
 * Downloads one release file and writes it into `dir` only if its SHA-256 matches the line in the
 * same release's `checksums.txt`. Returns the path of the written file.
 */
export async function downloadVerified(o: {
  fetch: Fetch;
  base: string;
  asset: string;
  dir: string;
}): Promise<string> {
  const sums = await o.fetch(`${o.base}/checksums.txt`);
  if (!sums.ok) throw new Error(`could not download checksums.txt (HTTP ${sums.status})`);
  const want = parseChecksum(await sums.text(), o.asset);
  if (!want) throw new Error(`no checksum is listed for ${o.asset}`);

  const bin = await o.fetch(`${o.base}/${o.asset}`);
  if (!bin.ok) throw new Error(`could not download ${o.asset} (HTTP ${bin.status})`);
  const data = Buffer.from(await bin.arrayBuffer());
  const got = createHash("sha256").update(data).digest("hex");
  if (got !== want) {
    throw new Error(`checksum mismatch for ${o.asset} (expected ${want}, got ${got})`);
  }

  const file = path.join(o.dir, o.asset.endsWith(".exe") ? "claude-gauges.exe" : "claude-gauges");
  await writeFile(file, data);
  await chmod(file, 0o755);
  return file;
}
```

- [ ] **Step 4: Run the test and the full check**

Run: `npx prettier --write src test && npm run test:ci`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/gauges/download.ts test/gauges/download.test.ts
git commit -m "feat: download a claude-gauges release file and verify its checksum"
```

---

### Task 3: The installer and settings helpers

**Files:**
- Create: `src/gauges/settings.ts`, `src/gauges/install.ts`
- Test: `test/gauges/install.test.ts`

**Interfaces:**
- Consumes: `assetName`, `releaseBase` (Task 1); `downloadVerified`, `Fetch` (Task 2).
- Produces:
  - `claudeSettingsPath(env: NodeJS.ProcessEnv): string` (`FOREMAN_CLAUDE_SETTINGS`, else `<USERPROFILE or HOME or the OS home>/.claude/settings.json`)
  - `currentStatusLineCommand(file: string): Promise<string | undefined>` (undefined when the file is missing, is not JSON or has no `statusLine.command` string; a leading byte order mark is ignored)
  - `isOldForemanCommand(cmd: string | undefined): boolean` (true when the trimmed command ends in `statusline` or `statusline.js"`)
  - `interface InstallGaugesDeps { fetch: Fetch; platform: NodeJS.Platform; arch: string; mkTmp(): Promise<string>; rmTmp(dir: string): Promise<void>; run(exe: string, args: string[]): Promise<number>; out(s: string): void; err(s: string): void; currentCommand?: string }`
  - `installGauges(d: InstallGaugesDeps, o: { force: boolean; version?: string }): Promise<number>` returns the exit code.

- [ ] **Step 1: Write the failing test**

`test/gauges/install.test.ts`:
```ts
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
    expect(claudeSettingsPath({ HOME: "/home/a" })).toBe(path.join("/home/a", ".claude", "settings.json"));
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/gauges/install.test.ts`
Expected: FAIL (cannot find modules `../../src/gauges/install.js` and `../../src/gauges/settings.js`)

- [ ] **Step 3: Write the implementation**

`src/gauges/settings.ts`:
```ts
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function claudeSettingsPath(env: NodeJS.ProcessEnv): string {
  if (env.FOREMAN_CLAUDE_SETTINGS) return env.FOREMAN_CLAUDE_SETTINGS;
  const home = env.USERPROFILE || env.HOME || os.homedir();
  return path.join(home, ".claude", "settings.json");
}

/** The command of the status line in Claude Code's settings, or undefined when there is none. */
export async function currentStatusLineCommand(file: string): Promise<string | undefined> {
  try {
    const text = (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
    const cmd = (JSON.parse(text) as { statusLine?: { command?: unknown } }).statusLine?.command;
    return typeof cmd === "string" ? cmd : undefined;
  } catch {
    return undefined;
  }
}

/** True for the command older agy-foreman versions installed: node ".../dist/statusline.js". */
export function isOldForemanCommand(cmd: string | undefined): boolean {
  return !!cmd && /statusline(\.js")?$/.test(cmd.trim());
}
```

`src/gauges/install.ts`:
```ts
import { assetName, releaseBase } from "./asset.js";
import { downloadVerified, type Fetch } from "./download.js";
import { isOldForemanCommand } from "./settings.js";

export interface InstallGaugesDeps {
  fetch: Fetch;
  platform: NodeJS.Platform;
  arch: string;
  mkTmp(): Promise<string>;
  rmTmp(dir: string): Promise<void>;
  run(exe: string, args: string[]): Promise<number>;
  out(s: string): void;
  err(s: string): void;
  /** The command of the status line in Claude Code's settings now, if any. */
  currentCommand?: string;
}

/**
 * Downloads the claude-gauges release for this system, verifies it and runs its `install`.
 * Returns the exit code to use.
 */
export async function installGauges(
  d: InstallGaugesDeps,
  o: { force: boolean; version?: string },
): Promise<number> {
  const asset = assetName(d.platform, d.arch);
  if (!asset) {
    d.err(
      `claude-gauges has no build for ${d.platform} ${d.arch}. Install it yourself: agy-foreman statusline --manual`,
    );
    return 1;
  }

  const replacingOld = isOldForemanCommand(d.currentCommand);
  if (replacingOld) {
    d.out(
      "Replacing the old agy-foreman status line. claude-gauges saves it, and `claude-gauges uninstall` restores it.",
    );
  }
  const args = ["install", ...(o.force || replacingOld ? ["--force"] : [])];

  const dir = await d.mkTmp();
  try {
    d.out(`Downloading ${asset}...`);
    const exe = await downloadVerified({
      fetch: d.fetch,
      base: releaseBase(o.version),
      asset,
      dir,
    });
    return await d.run(exe, args);
  } catch (e) {
    d.err(`status line: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    await d.rmTmp(dir);
  }
}
```

- [ ] **Step 4: Run the test and the full check**

Run: `npx prettier --write src test && npm run test:ci`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/gauges/settings.ts src/gauges/install.ts test/gauges/install.test.ts
git commit -m "feat: install claude-gauges from a verified release download"
```

---

### Task 4: Wire the command, remove the old renderer, update the docs

**Files:**
- Modify: `src/cli.ts`, `src/index.ts`, `tsup.config.ts`, `README.md`, `test/cli.test.ts`
- Create: `src/statusline-stub.ts`
- Delete: `src/statusline.ts`, `src/statusline-main.ts`, `test/statusline.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 to 3.
- Produces: `Io` gains `ask?: (question: string) => Promise<string>` and `gauges?: Partial<InstallGaugesDeps>`; it loses `stdin`. `readStdin` is no longer exported from `cli.ts`.

- [ ] **Step 1: Write the failing tests**

In `test/cli.test.ts`:

1. Add to the imports at the top:
```ts
import { createHash } from "node:crypto";
import { assetName } from "../src/gauges/asset.js";
import type { Fetch } from "../src/gauges/download.js";
```
2. Append at the end of the file:
```ts
describe("statusline", () => {
  it("prints the commands for --manual", async () => {
    const a = io();
    expect(await main(["statusline", "--manual"], a.i)).toBe(0);
    const text = a.out.join("\n");
    expect(text).toContain("install.sh | bash");
    expect(text).toContain("install.ps1 | iex");
  });

  it("asks, and prints the commands when the answer is 2", async () => {
    const a = io();
    a.i.ask = async () => "2";
    expect(await main(["statusline"], a.i)).toBe(0);
    const text = a.out.join("\n");
    expect(text).toContain("[1] Install claude-gauges");
    expect(text).toContain("install.sh | bash");
  });

  it("skips on an empty answer and asks again on a bad one", async () => {
    const answers = ["x", ""];
    const a = io();
    a.i.ask = async () => answers.shift() ?? "";
    expect(await main(["statusline"], a.i)).toBe(0);
    expect(a.err.join("\n")).toContain("Please type 1, 2 or 3.");
    expect(a.out.join("\n")).toContain("Skipped.");
  });

  it("gives up after three bad answers", async () => {
    const a = io();
    a.i.ask = async () => "nope";
    expect(await main(["statusline"], a.i)).toBe(1);
  });

  it("only shows the choices when there is no terminal", async () => {
    const a = io();
    expect(await main(["statusline"], a.i)).toBe(0);
    expect(a.out.join("\n")).toContain("agy-foreman statusline --install | --manual");
  });

  it("installs with --install through the verified download", async () => {
    const asset = assetName(process.platform, process.arch);
    if (!asset) return;
    const base = "https://github.com/mountaser/claude-gauges/releases/latest/download";
    const sha = createHash("sha256").update("binary").digest("hex");
    const files: Record<string, string> = {
      [`${base}/checksums.txt`]: `${sha}  ${asset}\n`,
      [`${base}/${asset}`]: "binary",
    };
    const fetch: Fetch = async (url) => ({
      ok: url in files,
      status: url in files ? 200 : 404,
      arrayBuffer: async () => new TextEncoder().encode(files[url] ?? "").buffer as ArrayBuffer,
      text: async () => files[url] ?? "",
    });
    const calls: string[][] = [];
    const a = io({ FOREMAN_CLAUDE_SETTINGS: path.join(os.tmpdir(), "no-such-settings.json") });
    a.i.gauges = {
      fetch,
      run: async (_exe, args) => {
        calls.push(args);
        return 0;
      },
    };
    expect(await main(["statusline", "--install"], a.i)).toBe(0);
    expect(calls).toEqual([["install"]]);
    calls.length = 0;
    expect(await main(["statusline", "--install", "--force"], a.i)).toBe(0);
    expect(calls).toEqual([["install", "--force"]]);
  });
});

describe("init and the status line", () => {
  it("does not touch Claude Code's settings and points at the statusline command", async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "foreman-init2-"));
    writeFileSync(path.join(repo, "go.mod"), "module x\n");
    const settings = path.join(repo, "claude-settings.json");
    const a = io({ FOREMAN_CLAUDE_SETTINGS: settings }, repo);
    expect(await main(["init"], a.i)).toBe(0);
    expect(existsSync(settings)).toBe(false);
    expect(a.out.join("\n")).toContain("agy-foreman statusline");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/cli.test.ts -t "statusline|init and the status line"`
Expected: FAIL (the `statusline` command still prints the old status line; `Io` has no `ask`/`gauges` fields, so `tsc` also fails)

- [ ] **Step 3: Rewrite the command in `src/cli.ts`**

1. Replace the two imports from `./statusline-main.js` and `./statusline.js` and the line `export { readStdin };` with:
```ts
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { installGauges, type InstallGaugesDeps } from "./gauges/install.js";
import { claudeSettingsPath, currentStatusLineCommand } from "./gauges/settings.js";
import { PROMPT, MANUAL, parseChoice, type Choice } from "./gauges/text.js";
```
(merge with the existing `node:*` imports as the file's style requires; `path` and `fileURLToPath` stay imported).
2. In `interface Io`, delete the `stdin` property and its comment, and add:
```ts
  /** Asks one question in the terminal; omitted when there is no terminal. */
  ask?: (question: string) => Promise<string>;
  /** Replaces parts of the claude-gauges installer, for tests. */
  gauges?: Partial<InstallGaugesDeps>;
```
3. In `HELP`, change the `init` line to `  init                  write .agy-foreman.json for this repo` and the `statusline` line to `  statusline            add the claude-gauges status line (--install, --manual, --force)`.
4. Delete the functions `cliEntry`, `statusLineFiles` and `describeInstall`.
5. Where the quota refresher decides whether a job is active, replace
```ts
        (await recentJobs(jobsDir({ env: io.env }))).some((j) => !isTerminal(j.state)),
```
with
```ts
        (await new JobStore(jobsDir({ env: io.env })).list()).some((j) => !isTerminal(j.state)),
```
6. Add before `export async function main`:
```ts
function defaultGaugesDeps(io: Io, currentCommand: string | undefined): InstallGaugesDeps {
  return {
    fetch: (url) => fetch(url),
    platform: process.platform,
    arch: process.arch,
    mkTmp: () => mkdtemp(path.join(os.tmpdir(), "claude-gauges-")),
    rmTmp: (dir) => rm(dir, { recursive: true, force: true }),
    run: (exe, args) =>
      new Promise((resolve) => {
        const child = spawn(exe, args, { stdio: "inherit" });
        child.on("error", () => resolve(1));
        child.on("close", (code) => resolve(code ?? 1));
      }),
    out: io.out,
    err: io.err,
    currentCommand,
    ...io.gauges,
  };
}
```
7. Replace the whole `if (cmd === "statusline") { ... }` block with:
```ts
  if (cmd === "statusline") {
    const force = argv.includes("--force");
    let choice: Choice | undefined = argv.includes("--install")
      ? "install"
      : argv.includes("--manual")
        ? "manual"
        : undefined;
    if (!choice) {
      io.out(PROMPT);
      if (!io.ask) {
        io.out("Choose with: agy-foreman statusline --install | --manual");
        return 0;
      }
      for (let tries = 0; tries < 3 && !choice; tries++) {
        choice = parseChoice(await io.ask("Choose 1, 2 or 3: "));
        if (!choice) io.err("Please type 1, 2 or 3.");
      }
      if (!choice) return 1;
    }
    if (choice === "manual") {
      io.out(MANUAL);
      return 0;
    }
    if (choice === "skip") {
      io.out("Skipped. Run agy-foreman statusline any time.");
      return 0;
    }
    const current = await currentStatusLineCommand(claudeSettingsPath(io.env));
    return installGauges(defaultGaugesDeps(io, current), { force });
  }
```
8. In the `init` command, replace the whole block from the comment `// The status line is on by default` through the closing brace of the `if (...) { io.out(describeInstall(...)); }` with:
```ts
    io.out(
      "Status line: run agy-foreman statusline to add claude-gauges (jobs, Gemini quota, Claude limits, cache timer).",
    );
```

- [ ] **Step 4: Update the entry point, the build and delete the old renderer**

1. `src/index.ts` becomes:
```ts
#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { main } from "./cli.js";

process.exitCode = await main(process.argv.slice(2), {
  out: console.log,
  err: console.error,
  ask: process.stdin.isTTY
    ? async (question) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await rl.question(question);
        } finally {
          rl.close();
        }
      }
    : undefined,
  env: process.env,
  cwd: process.cwd(),
});
```
2. Create `src/statusline-stub.ts`:
```ts
// Older agy-foreman versions put `node .../dist/statusline.js` into Claude Code's settings. That
// status line is now drawn by claude-gauges, so this prints nothing and keeps old settings working.
process.exit(0);
```
3. In `tsup.config.ts` change `statusline: "src/statusline-main.ts",` to `statusline: "src/statusline-stub.ts",`.
4. Delete the old renderer:
```bash
git rm src/statusline.ts src/statusline-main.ts test/statusline.test.ts
```

- [ ] **Step 5: Update the README**

In `README.md`:

1. In the CLI table, change the `statusline` row to
```
| `statusline`                      | Add the claude-gauges status line |
```
and change the `init` row to describe only the config file (`Write .agy-foreman.json for this repo`).
2. In the project tree near the end, change the `cli.ts` line to `├── cli.ts      serve, wait, watch, statusline, init, doctor, install-skill` and delete the line `└── statusline.ts` (make the `cli.ts` line use `└──` if it becomes the last entry of that tree).
3. Add this section directly before `### Status file`:
```markdown
### Status line

agy-foreman does not draw its own status line. [claude-gauges](https://github.com/mountaser/claude-gauges) shows your jobs, the Gemini quota, your Claude limits and the cache timer under the Claude Code prompt, and reads the status file below. Run `agy-foreman statusline` to install it: it asks first, downloads the release for your system and checks its SHA-256. `agy-foreman statusline --manual` prints the install commands instead.
```

- [ ] **Step 6: Run the full check and confirm the stub**

Run: `npx prettier --write src test README.md && npm run test:ci && npm run build && echo '{}' | node dist/statusline.js; echo "exit $?"`
Expected: all tests pass; the last two lines print nothing from the stub and `exit 0`.

- [ ] **Step 7: Commit**

```bash
git add -A src test tsup.config.ts README.md
git commit -m "feat: statusline command installs claude-gauges; remove the old renderer"
```
