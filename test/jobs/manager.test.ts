import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobManager, type JobManagerDeps } from "../../src/jobs/manager.js";
import { JobStore } from "../../src/jobs/store.js";
import { Ledger } from "../../src/jobs/ledger.js";
import { FlagStore } from "../../src/jobs/flags.js";
import { FakeApprover } from "../../src/jobs/approver.js";
import { parseProjectConfig, loadRuntimeConfig } from "../../src/config.js";
import type { Envelope, JobSpec, PipelineDeps } from "../../src/pipeline/index.js";
import { makeRepo, tmpRoot } from "../pipeline/repo.js";

const EST = { directTokens: 20000, delegateOverheadTokens: 4000, reason: "multi-file" };

function envelope(
  spec: JobSpec,
  state: Envelope["state"],
  extra: Partial<Envelope> = {},
): Envelope {
  return {
    jobId: spec.jobId,
    kind: spec.kind,
    state,
    branch: `agy/${spec.jobId}`,
    worktreePath: "/nowhere",
    baseSha: "b",
    untrustedReport: "",
    deniedCommands: [],
    guardEvents: [],
    skillsUsed: [],
    model: "gemini-3.8-flash-high",
    durationSec: 1,
    ...extra,
  };
}

function setup(
  o: {
    approver?: FakeApprover;
    result?: (spec: JobSpec) => Envelope;
    config?: object;
    fail?: string;
  } = {},
) {
  const state = mkdtempSync(path.join(os.tmpdir(), "foreman-mgr-"));
  const repo = makeRepo({ "a.txt": "a" });
  const specs: JobSpec[] = [];
  const approver = o.approver ?? new FakeApprover();
  let now = new Date("2026-10-17T12:00:00Z");
  const deps: JobManagerDeps = {
    store: new JobStore(path.join(state, "jobs")),
    ledger: new Ledger(path.join(state, "ledger.jsonl")),
    flags: new FlagStore(path.join(state, "flags.json")),
    approver,
    runJob: async (spec: JobSpec, pd: PipelineDeps) => {
      specs.push(spec);
      pd.onPhase?.("run");
      if (o.fail) throw new Error(o.fail);
      await new Promise((r) => setTimeout(r, 20));
      return (o.result ?? ((s) => envelope(s, "passed")))(spec);
    },
    pipelineDeps: {
      agyRun: (async () => {
        throw new Error("unused");
      }) as never,
      agyCommand: { command: "agy" },
      hookBundlePath: "",
      worktreeRoot: tmpRoot(),
      home: os.homedir(),
      now: () => now,
    },
    loadConfig: () => ({
      project: parseProjectConfig({ test_command: ["node", "-e", "process.exit(1)"], ...o.config }),
      runtime: loadRuntimeConfig({}),
    }),
    now: () => now,
  };
  return { m: new JobManager(deps), deps, repo, specs, approver, setNow: (d: Date) => (now = d) };
}

const PLAN =
  "# Demo Plan\n\n### Task 1: First\n\n- Create: `src/a.ts`\n\n### Task 2: Second\n\n- Create: `src/b.ts`\n";

describe("JobManager.start", () => {
  it("runs an ad-hoc implement task after a task card, and records the result", async () => {
    const { m, repo, approver, specs } = setup();
    const r = await m.start({
      repoRoot: repo,
      kind: "implement",
      task: "Fix add()\nmore detail",
      estimate: EST,
    });
    expect(r).toMatchObject({
      state: "running",
      waitHint: expect.stringMatching(/^agy-foreman wait t-/),
    });
    await m.idle();
    const rec = await m.get((r as { jobId: string }).jobId);
    expect(rec?.state).toBe("passed");
    expect(rec?.progress.percent).toBe(100);
    expect(rec?.title).toBe("Fix add()");
    expect(approver.calls.map((c) => c.kind)).toEqual(["task"]);
    expect(specs[0]).toMatchObject({ kind: "implement", task: "Fix add()\nmore detail" });
  });

  it("refuses without an estimate or when delegating is cheaper to skip", async () => {
    const { m, repo } = setup();
    expect(await m.start({ repoRoot: repo, kind: "implement", task: "x" })).toMatchObject({
      state: "refused",
      reason: expect.stringMatching(/estimate required/),
    });
    expect(
      await m.start({
        repoRoot: repo,
        kind: "implement",
        task: "x",
        estimate: { directTokens: 3000, delegateOverheadTokens: 4000, reason: "" },
      }),
    ).toMatchObject({ state: "refused", reason: expect.stringMatching(/cheaper to do directly/) });
  });

  it("refuses contract tests without test_report before showing a card", async () => {
    const { m, repo, approver, specs } = setup();
    const contract = [{ path: "test/a.test.ts", content: "it('x', () => {});\n" }];
    const r = await m.start({
      repoRoot: repo,
      kind: "implement",
      task: "x",
      contractTests: contract,
      estimate: EST,
    });
    expect(r).toMatchObject({ state: "refused", reason: expect.stringMatching(/test_report/) });
    expect(approver.calls).toEqual([]);
    expect(specs).toEqual([]);
  });

  it("returns denied when the user denies the card", async () => {
    const { m, repo } = setup({ approver: new FakeApprover({ task: false }) });
    expect(
      await m.start({ repoRoot: repo, kind: "explore", task: "How does x work?" }),
    ).toMatchObject({ state: "denied" });
  });

  it("asks once per plan, then runs later steps without a card until the plan changes", async () => {
    const { m, repo, approver } = setup();
    const file = path.join(repo, "plan.md");
    writeFileSync(file, PLAN);
    await m.start({
      repoRoot: repo,
      kind: "implement",
      plan: { file, step: 1, delegateSteps: [1, 2] },
      estimate: EST,
    });
    await m.start({ repoRoot: repo, kind: "implement", plan: { file, step: 2 }, estimate: EST });
    expect(approver.calls.map((c) => c.kind)).toEqual(["plan"]);
    expect(approver.calls[0].card as { steps: number[]; title: string }).toMatchObject({
      steps: [1, 2],
      title: "Demo Plan",
    });
    writeFileSync(file, PLAN + "\n### Task 3: Third\n");
    await m.start({ repoRoot: repo, kind: "implement", plan: { file, step: 3 }, estimate: EST });
    expect(approver.calls.map((c) => c.kind)).toEqual(["plan", "plan"]);
    await m.idle();
  });

  it("uses per-task cards for plans when approval is per_task", async () => {
    const { m, repo, approver } = setup({ config: { approval: "per_task" } });
    const file = path.join(repo, "plan.md");
    writeFileSync(file, PLAN);
    await m.start({ repoRoot: repo, kind: "implement", plan: { file, step: 1 }, estimate: EST });
    expect(approver.calls.map((c) => c.kind)).toEqual(["task"]);
    await m.idle();
  });

  it("dry run needs no approval and creates no job", async () => {
    const { m, repo, approver, deps } = setup();
    const r = await m.start({ repoRoot: repo, kind: "implement", task: "Do it", dryRun: true });
    expect(r).toMatchObject({ state: "dry_run" });
    if (r.state === "dry_run") {
      expect(r.brief).toContain("<task>");
      expect(r.command).toEqual(
        expect.arrayContaining(["--output-format", "stream-json", "--print-timeout"]),
      );
    }
    expect(approver.calls).toEqual([]);
    expect(await deps.store.list()).toEqual([]);
  });

  it("queues beyond max_concurrent and runs the queue afterwards", async () => {
    const { m, repo } = setup({ config: { max_concurrent: 1 } });
    const a = await m.start({ repoRoot: repo, kind: "explore", task: "a" });
    const b = await m.start({ repoRoot: repo, kind: "explore", task: "b" });
    expect([a.state, b.state]).toEqual(["running", "queued"]);
    await m.idle();
    expect((await m.get((b as { jobId: string }).jobId))?.state).toBe("passed");
  });
});

describe("quota handling", () => {
  it("sets a cooldown, shows the quota card once, and wait keeps refusing", async () => {
    const approver = new FakeApprover({ quota: "wait" });
    const { m, repo } = setup({
      approver,
      result: (s) => envelope(s, "quota", { quota: { resetInSec: 600, resetText: "10m" } }),
    });
    await m.start({ repoRoot: repo, kind: "explore", task: "a" });
    await m.idle();
    expect(approver.calls.filter((c) => c.kind === "quota")).toHaveLength(1);
    const r = await m.start({ repoRoot: repo, kind: "explore", task: "b" });
    expect(r).toMatchObject({ state: "quota", options: ["retry", "continue_without", "wait"] });
    expect(approver.calls.filter((c) => c.kind === "task")).toHaveLength(1);
  });

  it("continue_without pauses delegation until resumed", async () => {
    const approver = new FakeApprover({ quota: "continue_without" });
    const { m, repo } = setup({
      approver,
      result: (s) => envelope(s, "quota", { quota: { resetInSec: 600 } }),
    });
    await m.start({ repoRoot: repo, kind: "explore", task: "a" });
    await m.idle();
    expect(await m.start({ repoRoot: repo, kind: "explore", task: "b" })).toMatchObject({
      state: "refused",
      reason: expect.stringMatching(/resume_delegation/),
    });
    await m.act({ action: "resume_delegation" });
    expect((await m.status()).delegation).toBe("active");
  });

  it("retry clears the cooldown and continues the paused task as a follow-up", async () => {
    let calls = 0;
    const approver = new FakeApprover({ quota: "retry" });
    const { m, repo, specs } = setup({
      approver,
      result: (s) =>
        calls++ === 0
          ? envelope(s, "quota", { quota: { resetInSec: 600 }, conversationId: "c1" })
          : envelope(s, "passed"),
    });
    await m.start({ repoRoot: repo, kind: "implement", task: "build it", estimate: EST });
    await m.idle();
    expect(specs).toHaveLength(2);
    expect(specs[1]).toMatchObject({ conversationId: "c1", baseRef: `agy/${specs[0].jobId}` });
    expect(specs[1].task).toContain("usage limit");
  });
});

describe("act", () => {
  it("follow-up builds on the parent branch and conversation", async () => {
    const { m, repo, specs } = setup({
      result: (s) => envelope(s, "failed", { conversationId: "conv-9" }),
    });
    const r = await m.start({ repoRoot: repo, kind: "implement", task: "build", estimate: EST });
    await m.idle();
    const f = await m.act({
      action: "followup",
      jobId: (r as { jobId: string }).jobId,
      feedback: "handle empty input",
    });
    expect(f.jobId).toMatch(/^t-/);
    await m.idle();
    expect(specs[1]).toMatchObject({ baseRef: `agy/${specs[0].jobId}`, conversationId: "conv-9" });
    expect(specs[1].task).toContain("handle empty input");
    expect(specs[1].contractTests ?? []).toEqual([]);
  });

  it("revoke_plan forces a new plan card", async () => {
    const { m, repo, approver } = setup();
    const file = path.join(repo, "plan.md");
    writeFileSync(file, PLAN);
    await m.start({ repoRoot: repo, kind: "implement", plan: { file, step: 1 }, estimate: EST });
    await m.act({ action: "revoke_plan", planFile: file });
    await m.start({ repoRoot: repo, kind: "implement", plan: { file, step: 2 }, estimate: EST });
    expect(approver.calls.map((c) => c.kind)).toEqual(["plan", "plan"]);
    await m.idle();
  });

  it("quota_choice applies the user's choice in client mode", async () => {
    const approver = new FakeApprover({ quota: "unavailable" });
    const { m, repo } = setup({
      approver,
      result: (s) => envelope(s, "quota", { quota: { resetInSec: 600 } }),
    });
    await m.start({ repoRoot: repo, kind: "explore", task: "a" });
    await m.idle();
    expect(await m.start({ repoRoot: repo, kind: "explore", task: "b" })).toMatchObject({
      state: "quota",
    });
    expect(await m.act({ action: "quota_choice", choice: "retry" })).toMatchObject({
      state: "ok",
      choice: "retry",
    });
    expect((await m.start({ repoRoot: repo, kind: "explore", task: "c" })).state).toBe("running");
    await m.idle();
  });
});

describe("progress checklist from plan steps", () => {
  it("builds one item per non-test file plus a verification item", async () => {
    const { m, repo, specs } = setup();
    const file = path.join(repo, "plan.md");
    writeFileSync(
      file,
      "# P\n\n### Task 1: Store\n\n- Create: `src/jobs/a.ts`, `src/jobs/b.ts`\n- Test: `test/jobs/a.test.ts`\n",
    );
    await m.start({ repoRoot: repo, kind: "implement", plan: { file, step: 1 }, estimate: EST });
    await m.idle();
    expect(specs[0].checklist).toEqual([
      "Implement src/jobs/a.ts",
      "Implement src/jobs/b.ts",
      "Run the verification commands and fix failures",
    ]);
  });
});

describe("compactRecord", () => {
  it("drops the test output of passed jobs and caps reports", async () => {
    const { compactRecord } = await import("../../src/jobs/manager.js");
    const verify = {
      exitCode: 0,
      timedOut: false,
      passed: true,
      newSkips: 0,
      fewerTests: false,
      protectedRestored: [],
      tamper: [],
      auditFlags: [],
      failures: [],
      outputTail: "x".repeat(9000),
    };
    const base = {
      id: "t-1",
      kind: "implement",
      repoRoot: "/r",
      title: "t",
      state: "passed",
      progress: {},
      createdAt: "",
      updatedAt: "",
      returnedChars: 0,
    } as never as import("../../src/jobs/store.js").JobRecord;
    const env = {
      state: "passed",
      verify,
      untrustedReport: "<<<AGY-UNTRUSTED nonce=ab>>>\n" + "r".repeat(5000) + "\n<<<END nonce=ab>>>",
    } as never;
    const c = compactRecord({ ...base, envelope: env });
    expect("outputTail" in (c.envelope!.verify as object)).toBe(false);
    expect(c.envelope!.untrustedReport.length).toBeLessThan(3000);
    expect(c.envelope!.untrustedReport.endsWith("<<<END nonce=ab>>>")).toBe(true);
    const failed = compactRecord({
      ...base,
      envelope: {
        ...(env as object),
        state: "failed",
        verify: { ...verify, passed: false },
      } as never,
    });
    expect(failed.envelope!.verify!.outputTail.length).toBe(1500);
  });
});

// Regression (found live): a job ended as "error" and the reason was thrown away.
describe("pipeline errors", () => {
  it("keeps the error message on the job record", async () => {
    const { m, repo } = setup({ fail: "agy exploded" });
    const r = await m.start({ repoRoot: repo, kind: "implement", task: "Fix it", estimate: EST });
    await m.idle();
    const rec = await m.get((r as { jobId: string }).jobId);
    expect(rec?.state).toBe("error");
    expect(rec?.errorReason).toBe("agy exploded");
  });
});
