import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  main,
  waitExitCode,
  summaryLines,
  detectTestCommand,
  doctor,
  type Io,
} from "../src/cli.js";
import { JobStore, emptyProgress, type JobRecord } from "../src/jobs/store.js";
import { createHash } from "node:crypto";
import { assetName } from "../src/gauges/asset.js";
import type { Fetch } from "../src/gauges/download.js";

function io(env: NodeJS.ProcessEnv = {}, cwd = os.tmpdir()) {
  const out: string[] = [];
  const err: string[] = [];
  const i: Io = { out: (s) => out.push(s), err: (s) => err.push(s), env, cwd };
  return { i, out, err };
}
const rec = (id: string, state: JobRecord["state"]): JobRecord => ({
  id,
  kind: "implement",
  repoRoot: "/r",
  title: "t",
  state,
  progress: {
    ...emptyProgress(),
    percent: state === "running" ? 40 : 100,
    phase: state === "running" ? "run" : "done",
  },
  createdAt: "2026-10-17T10:00:00Z",
  updatedAt: "2026-10-17T10:00:00Z",
  returnedChars: 0,
  envelope:
    state === "running"
      ? undefined
      : ({
          state,
          diffStat: " a | 1 +\n b | 2 +-\n 2 files changed, 2 insertions(+), 1 deletion(-)",
          verify: {
            counts: { tests: 48, failures: 0, errors: 0, skipped: 0, failed: [] },
            passed: true,
          },
        } as never),
});

describe("waitExitCode and summaryLines", () => {
  it("maps states to exit codes", () => {
    expect([
      waitExitCode("passed"),
      waitExitCode("failed"),
      waitExitCode("guard_violation"),
      waitExitCode("quota"),
      waitExitCode("timeout"),
    ]).toEqual([0, 1, 1, 2, 3]);
  });
  it("summarizes a finished job", () => {
    expect(summaryLines(rec("t-1", "passed"))).toEqual([
      "t-1 passed · 48/48 tests · 2 files changed",
      "next: agy_get t-1",
    ]);
  });
});

describe("wait and watch", () => {
  it("waits for a terminal state and returns its exit code", async () => {
    const state = mkdtempSync(path.join(os.tmpdir(), "foreman-cli-"));
    const store = new JobStore(path.join(state, "jobs"));
    await store.write(rec("t-w", "running"));
    setTimeout(() => void store.write(rec("t-w", "quota")), 300);
    const { i, out } = io({ FOREMAN_STATE_DIR: state });
    expect(await main(["wait", "t-w", "--timeout-sec", "10"], i)).toBe(2);
    expect(out.join("\n")).toContain("t-w quota");
  });
  it("times out and reports unknown jobs", async () => {
    const state = mkdtempSync(path.join(os.tmpdir(), "foreman-cli-"));
    await new JobStore(path.join(state, "jobs")).write(rec("t-s", "running"));
    expect(
      await main(["wait", "t-s", "--timeout-sec", "1"], io({ FOREMAN_STATE_DIR: state }).i),
    ).toBe(3);
    const u = io({ FOREMAN_STATE_DIR: state });
    expect(await main(["wait", "t-none", "--timeout-sec", "1"], u.i)).toBe(3);
    expect(u.out.concat(u.err).join("\n")).toContain("job not found");
  });
  it("watch --once prints one progress frame", async () => {
    const state = mkdtempSync(path.join(os.tmpdir(), "foreman-cli-"));
    await new JobStore(path.join(state, "jobs")).write(rec("t-p", "running"));
    const { i, out } = io({ FOREMAN_STATE_DIR: state });
    expect(await main(["watch", "--once"], i)).toBe(0);
    expect(out.join("\n")).toMatch(/t-p .*40% · run/);
  });
});

describe("detectTestCommand and init", () => {
  it("detects npm, pytest and go projects", () => {
    const npm = mkdtempSync(path.join(os.tmpdir(), "foreman-det-"));
    writeFileSync(
      path.join(npm, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );
    writeFileSync(path.join(npm, "package-lock.json"), "{}");
    expect(detectTestCommand(npm)).toEqual({
      test_command: ["npm", "test"],
      setup_command: ["npm", "ci"],
    });
    const py = mkdtempSync(path.join(os.tmpdir(), "foreman-det-"));
    writeFileSync(path.join(py, "pyproject.toml"), "[project]\nname='x'\n");
    expect(detectTestCommand(py)).toEqual({
      test_command: ["python", "-m", "pytest", "-q", "--junitxml=reports/junit.xml"],
      test_report: "reports/junit.xml",
    });
    const go = mkdtempSync(path.join(os.tmpdir(), "foreman-det-"));
    writeFileSync(path.join(go, "go.mod"), "module x\n");
    expect(detectTestCommand(go)).toEqual({ test_command: ["go", "test", "./..."] });
    expect(detectTestCommand(mkdtempSync(path.join(os.tmpdir(), "foreman-det-")))).toEqual({});
  });
  it("init writes the config once and prints the registration command", async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "foreman-init-"));
    writeFileSync(path.join(repo, "go.mod"), "module x\n");
    const a = io({}, repo);
    expect(await main(["init"], a.i)).toBe(0);
    expect(JSON.parse(readFileSync(path.join(repo, ".agy-foreman.json"), "utf8"))).toEqual({
      test_command: ["go", "test", "./..."],
    });
    expect(a.out.join("\n")).toContain("claude mcp add agy-foreman -- npx -y agy-foreman serve");
    expect(await main(["init"], io({}, repo).i)).toBe(1);
    expect(existsSync(path.join(repo, ".agy-foreman.json"))).toBe(true);
  });
});

describe("doctor", () => {
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", timedOut: false });
  it("passes when everything is present", async () => {
    const checks = await doctor({
      nodeVersion: "v22.1.0",
      model: "gemini-3.8-flash-high",
      run: async (argv) =>
        argv[0] === "git"
          ? ok("git version 2.54.0.windows.1")
          : argv[1] === "models"
            ? ok("gemini-3.8-flash-high\tGemini 3.8 Flash (High)")
            : ok("1.4.0"),
    });
    expect(checks.map((c) => [c.name, c.ok])).toEqual([
      ["node", true],
      ["agy", true],
      ["agy login", true],
      ["git", true],
    ]);
  });
  it("flags old node, missing agy login and old git", async () => {
    const checks = await doctor({
      nodeVersion: "v18.0.0",
      model: "gemini-3.8-flash-high",
      run: async (argv) =>
        argv[0] === "git"
          ? ok("git version 2.30.1")
          : argv[1] === "models"
            ? { code: 1, stdout: "", stderr: "authentication required", timedOut: false }
            : ok("1.4.0"),
    });
    expect(checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["node", "agy login", "git"]);
    expect(checks.find((c) => c.name === "agy login")?.detail).toMatch(/run `agy` once/);
  });
});

describe("help and version", () => {
  it("prints the version from package.json and a command list", async () => {
    const out: string[] = [];
    const io: Io = { out: (s) => out.push(s), err: (s) => out.push(s), env: {}, cwd: os.tmpdir() };
    expect(await main(["--version"], io)).toBe(0);
    const pkg = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    expect(out[0]).toBe(pkg.version);
    expect(await main(["--help"], io)).toBe(0);
    expect(out[1]).toContain("install-skill");
  });
});

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
    const a = io({
      FOREMAN_CLAUDE_SETTINGS: path.join(
        mkdtempSync(path.join(os.tmpdir(), "foreman-nosettings-")),
        "settings.json",
      ),
    });
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
