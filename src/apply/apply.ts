// `agy-foreman apply`: writes the files a plan step spells out in full, then runs the tests.
// A step that already contains its code does not need Gemini to retype it.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MISSING_TEST_COMMAND } from "../config.js";
import { parsePlanStep } from "../jobs/plan.js";
import { git } from "../pipeline/exec.js";
import { planFiles, type BlockProblem } from "./blocks.js";

export interface ApplyOptions {
  repoRoot: string;
  planFile: string;
  step: number;
  dryRun?: boolean;
  /** The project's `test_command`; the caller loads the config. */
  testCommand: string[] | undefined;
  run: (cmd: string[], cwd: string) => Promise<{ code: number; out: string }>;
}

export interface ApplyResult {
  ok: boolean;
  written: string[];
  problems: BlockProblem[];
  testExit?: number;
  testTail?: string;
}

const refuse = (reason: string, block = 0): ApplyResult => ({
  ok: false,
  written: [],
  problems: [{ block, reason }],
});

export async function applyStep(opts: ApplyOptions): Promise<ApplyResult> {
  if (!opts.testCommand || opts.testCommand.length === 0) return refuse(MISSING_TEST_COMMAND);

  const tracked = await git(["status", "--porcelain", "--untracked-files=no"], opts.repoRoot);
  if (tracked.trim() !== "") {
    return refuse("tracked files have uncommitted changes; commit or stash them first");
  }

  const markdown = await readFile(path.resolve(opts.repoRoot, opts.planFile), "utf8");
  const step = parsePlanStep(markdown, opts.step);
  const { files, problems } = planFiles(step.text, step.files);
  if (problems.length > 0) return { ok: false, written: [], problems };
  if (files.length === 0) return refuse("nothing to apply: the step has no file blocks");

  // A listed file with no block would mean the tests run against an incomplete step.
  const have = new Set(files.map((f) => f.path));
  const missing = step.files.filter((f) => !have.has(f));
  if (missing.length > 0) {
    return {
      ok: false,
      written: [],
      problems: missing.map((f) => ({ block: 0, reason: `no block found for listed file: ${f}` })),
    };
  }

  const existing = files.filter((f) => existsSync(path.resolve(opts.repoRoot, f.path)));
  if (existing.length > 0) {
    return {
      ok: false,
      written: [],
      problems: existing.map((f) => ({ block: 0, reason: `target exists: ${f.path}` })),
    };
  }

  const paths = files.map((f) => f.path);
  if (opts.dryRun) return { ok: true, written: paths, problems: [] };

  for (const f of files) {
    const target = path.resolve(opts.repoRoot, f.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, f.content, "utf8");
  }

  const result = await opts.run(opts.testCommand, opts.repoRoot);
  return {
    ok: result.code === 0,
    written: paths,
    problems: [],
    testExit: result.code,
    testTail: result.out.trimEnd().split("\n").slice(-40).join("\n") + "\n",
  };
}
