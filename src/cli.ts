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
import { jobsDir, stateDir } from "./paths.js";
import { runCommand, type ExecResult } from "./pipeline/exec.js";
import { createRuntime } from "./runtime.js";
import { createServer, ElicitationApprover } from "./server.js";
import { readStdin, statusLineText } from "./statusline-main.js";
import {
  claudeSettingsPath,
  installStatusLine,
  recentJobs,
  uninstallStatusLine,
  type InstallResult,
} from "./statusline.js";
import { quotaFile, refreshQuota, startQuotaRefresher } from "./usage-quota.js";

export { readStdin };

export const VERSION = "0.1.0";

const HELP = `agy-foreman ${VERSION}: hand plan tasks from Claude Code to Gemini, merge only what passes your tests

Usage: agy-foreman <command>

  serve                 run the MCP server over stdio (default)
  init                  write .agy-foreman.json for this repo and install the status line
  doctor                check node, git, agy and the agy login
  install-skill         install the delegation skill (--project for this repo only)
  wait <job>            block until a job ends (exit 0 passed, 1 failed, 2 quota, 3 error)
  watch [job]           show live progress
  statusline            print the status line (--install / --uninstall)
  --version, --help

Docs: https://github.com/mountaser/agy-foreman`;

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Reads piped stdin (statusline only); omitted in tests. */
  stdin?: () => Promise<string>;
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
  return [parts.join(" · "), `next: agy_get ${rec.id}`];
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
        const setup_command = hasLock ? ["npm", "ci"] : ["npm", "install"];
        // Contract tests need a JUnit report; vitest writes one when the flags reach it, which
        // they do when it is the script's last command.
        if (/(^|&&\s*)vitest(\s[^&|;]*)?$/.test(String(pkg.scripts.test).trim())) {
          return {
            test_command: [
              "npm",
              "test",
              "--",
              "--reporter=default",
              "--reporter=junit",
              "--outputFile.junit=reports/junit.xml",
            ],
            setup_command,
            test_report: "reports/junit.xml",
          };
        }
        return { test_command: ["npm", "test"], setup_command };
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

function cliEntry(): string {
  return fileURLToPath(import.meta.url);
}

function statusLineFiles(env: NodeJS.ProcessEnv): { settingsFile: string; wrapFile: string } {
  return {
    settingsFile: claudeSettingsPath(env),
    wrapFile: path.join(stateDir({ env }), "statusline-wrap.json"),
  };
}

function describeInstall(r: InstallResult): string {
  if (r.state === "already_installed") return `status line: already installed (${r.settings})`;
  if (r.state === "wrapped")
    return `status line: installed in ${r.settings}, shown after your existing one (${r.previous})`;
  return `status line: installed in ${r.settings} (restart Claude Code to see it; remove with: agy-foreman statusline --uninstall)`;
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
        (await recentJobs(jobsDir({ env: io.env }))).some((j) => !isTerminal(j.state)),
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
    const files = statusLineFiles(io.env);
    if (argv.includes("--install")) {
      io.out(describeInstall(await installStatusLine({ ...files, entry: cliEntry() })));
      return 0;
    }
    if (argv.includes("--uninstall")) {
      io.out(`status line: ${await uninstallStatusLine(files)}`);
      return 0;
    }
    // Same output as the slim dist/statusline.js that Claude Code runs.
    const text = await statusLineText({
      env: io.env,
      cwd: io.cwd,
      stdin: io.stdin ? await io.stdin() : "",
    });
    if (text) io.out(text);
    return 0;
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
    // The status line is on by default; it only touches Claude Code settings when a home dir is known.
    if (
      !argv.includes("--no-statusline") &&
      (io.env.FOREMAN_CLAUDE_SETTINGS || io.env.USERPROFILE || io.env.HOME)
    ) {
      io.out(
        describeInstall(await installStatusLine({ ...statusLineFiles(io.env), entry: cliEntry() })),
      );
    }
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
