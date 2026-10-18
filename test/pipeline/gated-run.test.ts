import { describe, it, expect, inject } from "vitest";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runJob, type JobSpec, type PipelineDeps } from "../../src/pipeline/index.js";
import { repoHash } from "../../src/pipeline/worktree.js";
import { buildGatePolicy } from "../../src/pipeline/gated-run.js";
import { decide } from "../../src/pipeline/gate.js";
import { resumePrompt } from "../../src/pipeline/brief.js";
import { parseProjectConfig, loadRuntimeConfig } from "../../src/config.js";
import { makeRepo, tmpRoot } from "./repo.js";

function setup(config: object) {
  const repo = makeRepo({ "src/a.mjs": "export const a = 1;\n", "README.md": "# demo\n" });
  const spec: JobSpec = {
    jobId: "j-" + Math.random().toString(16).slice(2, 8),
    kind: "implement",
    repoRoot: repo,
    task: "Do the thing.",
    contractTests: [{ path: "tests/a.test.mjs", content: "throw new Error('red');\n" }],
    conversationId: "c-1",
    timeoutSec: 30,
    config: parseProjectConfig(config),
    runtime: loadRuntimeConfig({}),
  };
  const deps: PipelineDeps = {
    agyRun: (async () => {
      throw new Error("agy crashed");
    }) as never,
    agyCommand: { command: "agy" },
    hookBundlePath: inject("hookBundle"),
    worktreeRoot: tmpRoot(),
    home: os.homedir(),
    now: () => new Date(),
  };
  return { repo, spec, deps };
}

describe("gated run", () => {
  it("removes an implement job's worktree when the run throws", async () => {
    const { repo, spec, deps } = setup({ test_command: ["node", "-e", "process.exit(1)"] });
    spec.contractTests = undefined;
    await expect(runJob(spec, deps)).rejects.toThrow("agy crashed");
    expect(existsSync(path.join(deps.worktreeRoot, repoHash(repo), spec.jobId))).toBe(false);
  }, 60_000);

  it("builds early-return envelopes with the same shared fields", async () => {
    const refused = setup({});
    const noTests = await runJob(refused.spec, refused.deps);
    const failed = setup({
      test_command: ["node", "-e", "process.exit(1)"],
      test_report: "reports/junit.xml",
      setup_command: ["node", "-e", "process.exit(7)"],
    });
    const setupFailed = await runJob(failed.spec, failed.deps);
    for (const env of [noTests, setupFailed]) {
      expect(env).toMatchObject({
        conversationId: "c-1",
        model: "gemini-3.8-flash-high",
        skillsUsed: [],
        deniedCommands: [],
        guardEvents: [],
      });
      expect(env.untrustedReport).toMatch(/^<<<AGY-UNTRUSTED nonce=[0-9a-f]{8}>>>/);
    }
    expect(noTests.state).toBe("refused");
    expect(setupFailed.state).toBe("error");
  }, 60_000);
});

// Regression (found in review): the gate's mode came from agy's run mode ("plan"), so explore
// jobs lost the gate's read-only rules.
describe("buildGatePolicy", () => {
  it("keeps explore jobs read-only whatever agy mode they run in", () => {
    const { spec } = setup({});
    expect(buildGatePolicy({ ...spec, kind: "explore" }, "/w").mode).toBe("explore");
    expect(buildGatePolicy(spec, "/w").mode).toBe("implement");
    const policy = buildGatePolicy({ ...spec, kind: "explore" }, "/w");
    expect(
      decide(policy, { name: "write_to_file", args: { TargetFile: "/w/a.ts" } }).decision,
    ).toBe("deny");
  });
});

// Regression (found live): a resumed followup re-read the previous worktree's brief.
describe("resumePrompt", () => {
  it("names the new brief explicitly", () => {
    expect(resumePrompt(String.raw`C:\wt\t-2\.agy-task\brief.md`)).toContain(
      "C:/wt/t-2/.agy-task/brief.md",
    );
  });
});
