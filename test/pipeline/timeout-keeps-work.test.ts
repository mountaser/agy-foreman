import { describe, it, expect, inject } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runJob, type JobSpec, type PipelineDeps } from "../../src/pipeline/index.js";
import type { Outcome, StreamEvent } from "../../src/agy/types.js";
import { parseProjectConfig, loadRuntimeConfig } from "../../src/config.js";
import { makeRepo, tmpRoot } from "./repo.js";

const GOOD = "export const add = (a, b) => a + b;\n";
const RUNNER = `import { add } from "./src/add.mjs";
if (add(2, 3) !== 5) { console.error("add broken"); process.exit(1); }
`;

type FakeRun = (
  req: { cwd: string; signal?: AbortSignal },
  onEvent?: (ev: StreamEvent) => void,
) => Promise<Outcome>;

function setup(agyRun: FakeRun, o: { stallAfterMs?: number } = {}) {
  const repo = makeRepo({
    "run.mjs": RUNNER,
    "src/add.mjs": "export const add = () => 0;\n",
    "README.md": "# demo\n",
  });
  const spec: JobSpec = {
    jobId: "j-" + Math.random().toString(16).slice(2, 8),
    kind: "implement",
    repoRoot: repo,
    task: "Make add() add.",
    timeoutSec: 30,
    config: parseProjectConfig({ test_command: ["node", "run.mjs"] }),
    runtime: loadRuntimeConfig({}),
  };
  const ac = new AbortController();
  const deps: PipelineDeps = {
    agyRun: agyRun as never,
    agyCommand: { command: "agy" },
    hookBundlePath: inject("hookBundle"),
    worktreeRoot: tmpRoot(),
    home: os.homedir(),
    now: () => new Date(),
    signal: ac.signal,
    stallAfterMs: o.stallAfterMs ?? 60_000,
    stallCheckMs: 20,
  };
  return { spec, deps, ac };
}

const fix = (cwd: string) => writeFileSync(path.join(cwd, "src", "add.mjs"), GOOD);
const step = (stepIndex: number, state: string, toolName = "run_command"): StreamEvent => ({
  kind: "step",
  stepIndex,
  state,
  stepType: "tool",
  toolName,
});
const waitForAbort = (signal?: AbortSignal) =>
  new Promise<Outcome>((resolve) =>
    signal?.addEventListener("abort", () => resolve({ type: "cancelled" }), { once: true }),
  );

describe("a timed-out run", () => {
  it("is verified, so finished work shows as green and partial", async () => {
    const { spec, deps } = setup(async (req) => {
      fix(req.cwd);
      return { type: "timeout", partialResponse: "" };
    });
    const env = await runJob(spec, deps);
    expect(env.state).toBe("timeout");
    expect(env.partial).toBe(true);
    expect(env.verify?.passed).toBe(true);
    expect(env.diffStat).toContain("src/add.mjs");
  }, 60_000);

  it("does not run the tests when it changed nothing", async () => {
    const { spec, deps } = setup(async () => ({ type: "timeout", partialResponse: "" }));
    const env = await runJob(spec, deps);
    expect(env.state).toBe("timeout");
    expect(env.partial).toBeUndefined();
    expect(env.verify).toBeUndefined();
  }, 60_000);
});

describe("a stalled run", () => {
  it("ends early as passed when it went quiet and the tests pass", async () => {
    const { spec, deps } = setup(
      async (req, onEvent) => {
        fix(req.cwd);
        onEvent?.(step(1, "ACTIVE"));
        onEvent?.(step(1, "DONE"));
        return await waitForAbort(req.signal);
      },
      { stallAfterMs: 100 },
    );
    const env = await runJob(spec, deps);
    expect(env.state).toBe("passed");
    expect(env.reason).toBe("ended early: no activity and verify passes");
    expect(env.verify?.passed).toBe(true);
  }, 60_000);

  it("ends as a partial timeout when it went quiet and the tests fail", async () => {
    const { spec, deps } = setup(
      async (req, onEvent) => {
        writeFileSync(path.join(req.cwd, "src", "other.mjs"), "x\n");
        onEvent?.(step(1, "DONE"));
        return await waitForAbort(req.signal);
      },
      { stallAfterMs: 100 },
    );
    const env = await runJob(spec, deps);
    expect(env.state).toBe("timeout");
    expect(env.partial).toBe(true);
    expect(env.verify?.passed).toBe(false);
  }, 60_000);

  it("is not a stall while a tool step is still running", async () => {
    const { spec, deps } = setup(
      async (req, onEvent) => {
        fix(req.cwd);
        onEvent?.(step(1, "ACTIVE"));
        await new Promise((r) => setTimeout(r, 400));
        onEvent?.(step(1, "DONE"));
        return {
          type: "success",
          response: "done",
          usage: { totalTokens: 1 } as never,
          durationSec: 1,
        };
      },
      { stallAfterMs: 100 },
    );
    const env = await runJob(spec, deps);
    expect(env.state).toBe("passed");
    expect(env.reason).toBeUndefined();
  }, 60_000);

  it("leaves a cancel by the user as cancelled", async () => {
    const { spec, deps, ac } = setup(
      async (req) => {
        setTimeout(() => ac.abort(), 30);
        return await waitForAbort(req.signal);
      },
      { stallAfterMs: 60_000 },
    );
    const env = await runJob(spec, deps);
    expect(env.state).toBe("cancelled");
  }, 60_000);
});
