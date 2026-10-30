import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, loadRuntimeConfig } from "./config.js";
import { ClientModeApprover } from "./jobs/approver.js";
import { renderProgressLine } from "./jobs/progress.js";
import { isTerminal, JobStore, type JobRecord } from "./jobs/store.js";
import { watchJob } from "./jobs/watch.js";
import { applyStep } from "./apply/apply.js";
import { Ledger } from "./jobs/ledger.js";
import { buildReport } from "./report.js";
import { jobsDir, stateDir } from "./paths.js";
import { runCommand, type ExecResult } from "./pipeline/exec.js";
import { createRuntime } from "./runtime.js";
import { createServer, ElicitationApprover } from "./server.js";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { installGauges, type InstallGaugesDeps } from "./gauges/install.js";
import { claudeSettingsPath, currentStatusLineCommand } from "./gauges/settings.js";
import { PROMPT, MANUAL, parseChoice, type Choice } from "./gauges/text.js";
import { quotaFile, refreshQuota, startQuotaRefresher } from "./usage-quota.js";

export const VERSION = "0.2.1";

const HELP = `agy-foreman ${VERSION}: hand plan tasks from Claude Code to Gemini, merge only what passes your tests

Usage: agy-foreman <command>

  serve                 run the MCP server over stdio (default)
  init                  write .agy-foreman.json for this repo
  doctor                check node, git, agy and the agy login
  install-skill         install the delegation skill (--project for this repo only)
  wait <job>            block until a job ends (exit 0 passed, 1 failed, 2 quota, 3 error)
  watch [job]           show live progress
  apply <plan> <step>   write the files a plan step spells out in full, then run the tests (--dry-run)
  report                what the delegated jobs cost: states, tokens, incidents (--since YYYY-MM-DD)
  statusline            add the claude-gauges status line (--install, --manual, --force)
  --version, --help

Docs: https://github.com/mountaser/agy-foreman`;

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Asks one question in the terminal; omitted when there is no terminal. */
  ask?: (question: string) => Promise<string>;
  /** Replaces parts of the claude-gauges installer, for tests. */
  gauges?: Partial<InstallGaugesDeps>;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export function waitExitCode(state: string): number {
  if (state === "passed") return 0;
  if (
    state === "failed" ||
    state === "conflict" ||
    state === "refused" ||
    state === "denied" ||
    state === "guard_violation"
  ) {
    return 1;
  }
  if (state === "quota") return 2;
  return 3;
}

export function summaryLines(rec: JobRecord): string[] {
  const parts: string[] = [`${rec.id} ${rec.state}`];
  if (rec.envelope?.verify?.counts) {
    const c = rec.envelope.verify.counts;
    const passed = c.tests - (c.failures ?? 0) - (c.errors ?? 0);
    parts.push(`${passed}/${c.tests} tests`);
  }
  if (rec.envelope?.diffStat) {
    const m = rec.envelope.diffStat.match(/(\d+)\s+file/);
    if (m) {
      const count = parseInt(m[1], 10);
      parts.push(`${count} file${count === 1 ? "" : "s"} changed`);
    }
  }
  const lines = [parts.join(" · ")];
  // A refused or errored job has no result worth a second call; the reason is the news.
  const reason = rec.envelope?.reason ?? rec.errorReason;
  if ((rec.state === "refused" || rec.state === "error") && reason) {
    lines.push(`reason: ${reason}`);
  }
  lines.push(`next: agy_get ${rec.id}`);
  return lines;
}

export function detectTestCommand(repoRoot: string): {
  test_command?: string[];
  setup_command?: string[];
  test_report?: string;
} {
  const pkgPath = path.join(repoRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg?.scripts?.test) {
        const hasLock =
          existsSync(path.join(repoRoot, "package-lock.json")) ||
          existsSync(path.join(repoRoot, "npm-shrinkwrap.json")) ||
          existsSync(path.join(repoRoot, "yarn.lock")) ||
          existsSync(path.join(repoRoot, "pnpm-lock.yaml")) ||
          existsSync(path.join(repoRoot, "bun.lockb")) ||
          existsSync(path.join(repoRoot, "bun.lock"));
        return {
          test_command: ["npm", "test"],
          setup_command: hasLock ? ["npm", "ci"] : ["npm", "install"],
        };
      }
    } catch {
      // ignore
    }
  }

  const pyproject = path.join(repoRoot, "pyproject.toml");
  const pytestIni = path.join(repoRoot, "pytest.ini");
  if (existsSync(pyproject) || existsSync(pytestIni)) {
    return {
      test_command: ["python", "-m", "pytest", "-q", "--junitxml=reports/junit.xml"],
      test_report: "reports/junit.xml",
    };
  }

  const goMod = path.join(repoRoot, "go.mod");
  if (existsSync(goMod)) {
    return {
      test_command: ["go", "test", "./..."],
    };
  }

  const makefile = path.join(repoRoot, "Makefile");
  if (existsSync(makefile)) {
    try {
      const content = readFileSync(makefile, "utf8");
      if (/^test\s*:/m.test(content)) {
        return {
          test_command: ["make", "test"],
        };
      }
    } catch {
      // ignore
    }
  }

  return {};
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function doctor(d: {
  run: (argv: string[]) => Promise<ExecResult>;
  model: string;
  nodeVersion: string;
}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // 1. node (version >= 20)
  const nodeMatch = d.nodeVersion.match(/^v?(\d+)/);
  const nodeMajor = nodeMatch ? parseInt(nodeMatch[1], 10) : 0;
  const nodeOk = nodeMajor >= 20;
  checks.push({
    name: "node",
    ok: nodeOk,
    detail: nodeOk ? d.nodeVersion : `${d.nodeVersion} (Node.js >= 20 required)`,
  });

  // 2. agy (agy --version exits 0)
  let agyOk = false;
  let agyDetail = "";
  try {
    const res = await d.run(["agy", "--version"]);
    agyOk = res.code === 0;
    agyDetail = agyOk ? res.stdout.trim() : res.stderr.trim() || "agy not found";
  } catch (e) {
    agyDetail = (e as Error).message;
  }
  checks.push({
    name: "agy",
    ok: agyOk,
    detail: agyDetail,
  });

  // 3. agy login (agy models exits 0 and output contains model)
  let loginOk = false;
  let loginDetail = "";
  try {
    const res = await d.run(["agy", "models"]);
    if (res.code === 0 && res.stdout.includes(d.model)) {
      loginOk = true;
      loginDetail = `logged in (model ${d.model} available)`;
    } else {
      loginDetail = `model ${d.model} not available or authentication required; run \`agy\` once interactively to log in`;
    }
  } catch (e) {
    loginDetail = `run \`agy\` once interactively to log in: ${(e as Error).message}`;
  }
  checks.push({
    name: "agy login",
    ok: loginOk,
    detail: loginDetail,
  });

  // 4. git (git --version >= 2.38)
  let gitOk = false;
  let gitDetail = "";
  try {
    const res = await d.run(["git", "--version"]);
    const gitMatch = res.stdout.match(/git version (\d+)\.(\d+)/);
    if (res.code === 0 && gitMatch) {
      const major = parseInt(gitMatch[1], 10);
      const minor = parseInt(gitMatch[2], 10);
      gitOk = major > 2 || (major === 2 && minor >= 38);
      gitDetail = gitOk ? res.stdout.trim() : `${res.stdout.trim()} (git >= 2.38 required)`;
    } else {
      gitDetail = res.stderr.trim() || res.stdout.trim() || "git not found";
    }
  } catch (e) {
    gitDetail = (e as Error).message;
  }
  checks.push({
    name: "git",
    ok: gitOk,
    detail: gitDetail,
  });

  return checks;
}

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

export async function main(argv: string[], io: Io): Promise<number> {
  const cmd = argv[0] ?? "serve";

  if (cmd === "--version" || cmd === "-v") {
    io.out(VERSION);
    return 0;
  }
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    io.out(HELP);
    return 0;
  }

  if (cmd === "serve") {
    let server: McpServer;
    const runtime = createRuntime({
      cwd: io.cwd,
      env: io.env,
      approverFor: (gate) =>
        gate === "client"
          ? new ClientModeApprover()
          : new ElicitationApprover(
              () => server,
              path.join(stateDir({ env: io.env }), "approvals.jsonl"),
            ),
    });
    await runtime.manager.recoverOrphans();
    server = createServer(runtime.manager, {
      defaultRepoRoot: () => io.cwd,
      version: VERSION,
    });
    const quota = startQuotaRefresher({
      file: quotaFile(io.env),
      isActive: async () =>
        (await new JobStore(jobsDir({ env: io.env })).list()).some((j) => !isTerminal(j.state)),
      refresh: () =>
        refreshQuota({ agyPath: loadRuntimeConfig(io.env).agyPath, file: quotaFile(io.env) }),
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    await new Promise<void>((resolve) => {
      transport.onclose = () => resolve();
      process.stdin.on("close", () => resolve());
      process.stdin.on("end", () => resolve());
    });
    quota.stop();
    return 0;
  }

  if (cmd === "wait") {
    const id = argv[1];
    let timeoutSec = 3600;
    const timeoutIdx = argv.indexOf("--timeout-sec");
    if (timeoutIdx !== -1 && argv[timeoutIdx + 1]) {
      timeoutSec = parseInt(argv[timeoutIdx + 1], 10);
    }
    const store = new JobStore(jobsDir({ env: io.env }));
    const rec = await watchJob(store, id, { timeoutMs: timeoutSec * 1000 });
    if (!rec) {
      io.err(`job not found: ${id}`);
      return 3;
    }
    if (!isTerminal(rec.state)) {
      io.err(`timeout waiting for ${id}`);
      return 3;
    }
    for (const line of summaryLines(rec)) {
      io.out(line);
    }
    return waitExitCode(rec.state);
  }

  if (cmd === "apply") {
    const planFile = argv[1];
    const step = Number(argv[2]);
    if (!planFile || !Number.isInteger(step) || step < 1) {
      io.err("usage: agy-foreman apply <plan-file> <step> [--dry-run]");
      return 2;
    }
    const config = loadConfig({ repoRoot: io.cwd, env: io.env });
    const result = await applyStep({
      repoRoot: io.cwd,
      planFile,
      step,
      dryRun: argv.includes("--dry-run"),
      testCommand: config.project.testCommand,
      run: async (command, cwd) => {
        const r = await runCommand(command, { cwd });
        return { code: r.code ?? 1, out: r.stdout + r.stderr };
      },
    });
    for (const p of result.problems)
      io.err(`apply: ${p.block > 0 ? `block ${p.block}: ` : ""}${p.reason}`);
    for (const f of result.written)
      io.out(`${argv.includes("--dry-run") ? "would write" : "wrote"} ${f}`);
    if (result.testTail !== undefined) {
      io.out(result.testTail.trimEnd());
      io.out(result.ok ? "tests passed" : `tests failed (exit ${result.testExit})`);
    }
    return result.ok ? 0 : 1;
  }

  if (cmd === "report") {
    const sinceIdx = argv.indexOf("--since");
    const sinceText = sinceIdx !== -1 ? argv[sinceIdx + 1] : undefined;
    const since = sinceText ? new Date(sinceText) : undefined;
    if (since && Number.isNaN(since.getTime())) {
      io.err("usage: agy-foreman report [--since YYYY-MM-DD]");
      return 2;
    }
    const ledger = new Ledger(path.join(stateDir({ env: io.env }), "ledger.jsonl"));
    const jobs = await new JobStore(jobsDir({ env: io.env })).list();
    io.out(
      buildReport(
        await ledger.entries(),
        jobs.map((j) => ({ id: j.id, returnedChars: j.returnedChars })),
        { since },
      ).trimEnd(),
    );
    return 0;
  }

  if (cmd === "watch") {
    const once = argv.includes("--once");
    const id = argv.slice(1).find((a) => !a.startsWith("--"));
    const store = new JobStore(jobsDir({ env: io.env }));
    if (id) {
      await watchJob(store, id, {
        timeoutMs: once ? 0 : undefined,
        onUpdate: (rec) => io.out(renderProgressLine(rec)),
      });
      return 0;
    }
    while (true) {
      const all = await store.list();
      const nonTerminal = all.filter((r) => !isTerminal(r.state));
      for (const rec of nonTerminal) {
        io.out(renderProgressLine(rec));
      }
      if (once || nonTerminal.length === 0) {
        return 0;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

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

  if (cmd === "init") {
    const targetFile = path.join(io.cwd, ".agy-foreman.json");
    if (existsSync(targetFile)) {
      io.err(".agy-foreman.json already exists");
      return 1;
    }
    const detected = detectTestCommand(io.cwd);
    writeFileSync(targetFile, JSON.stringify(detected, null, 2) + "\n", "utf8");
    io.out("Register with Claude Code:\n  claude mcp add agy-foreman -- npx -y agy-foreman serve");
    io.out(
      "Status line: run agy-foreman statusline to add claude-gauges (jobs, Gemini quota, Claude limits, cache timer).",
    );
    return 0;
  }

  if (cmd === "doctor") {
    const cfg = loadConfig({ repoRoot: io.cwd, env: io.env });
    const checks = await doctor({
      nodeVersion: process.version,
      model: cfg.project.model,
      run: (args) => runCommand(args, { cwd: io.cwd, env: io.env }),
    });
    for (const c of checks) {
      const mark = c.ok ? "✓" : "✗";
      io.out(`${mark} ${c.name}: ${c.detail}`);
    }
    return checks.some((c) => !c.ok) ? 1 : 0;
  }

  if (cmd === "install-skill") {
    let srcDir = io.env.FOREMAN_SKILL_SRC;
    if (!srcDir) {
      const candidate = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../skills/gemini-delegation",
      );
      if (existsSync(candidate)) {
        srcDir = candidate;
      } else {
        srcDir = path.join(io.cwd, "skills", "gemini-delegation");
      }
    }
    if (!existsSync(srcDir)) {
      io.err(`skill source not found: ${srcDir}`);
      return 1;
    }

    const isProject = argv.includes("--project");
    const home = io.env.USERPROFILE || io.env.HOME || "";
    const target = isProject
      ? path.join(io.cwd, ".claude", "skills", "gemini-delegation")
      : path.join(home, ".claude", "skills", "gemini-delegation");

    if (existsSync(target)) {
      io.out(`already installed: ${target}`);
      return 1;
    }

    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(srcDir, target, { recursive: true });
    io.out(`installed: ${target}`);
    return 0;
  }

  io.err(`unknown command: ${cmd}`);
  return 1;
}
