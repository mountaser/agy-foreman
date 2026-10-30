import { describe, it, expect } from "vitest";
import { buildSnapshot, cleanTitle, parseShortstat } from "../../src/snapshot/build.js";
import { emptyProgress, type JobRecord } from "../../src/jobs/store.js";
import type { DiffStat } from "../../src/snapshot/types.js";

const NOW = new Date("2026-10-30T14:30:00.000Z");

function rec(over: Partial<JobRecord> & { id: string }): JobRecord {
  return {
    kind: "implement",
    repoRoot: "/repo",
    title: "Task",
    state: "running",
    progress: emptyProgress(),
    createdAt: "2026-10-30T14:20:00.000Z",
    updatedAt: "2026-10-30T14:20:00.000Z",
    returnedChars: 0,
    ...over,
  };
}

const plan = (step: number, delegateSteps?: number[]) => ({
  file: "docs/p.md",
  step,
  ...(delegateSteps ? { delegateSteps } : {}),
});

const envelope = (totalTokens: number, diffStat: string) =>
  ({ usage: { totalTokens }, diffStat }) as unknown as JobRecord["envelope"];

describe("parseShortstat", () => {
  it("reads the summary line", () => {
    expect(parseShortstat("a.go | 63 +++\n 1 file changed, 63 insertions(+)")).toEqual({
      files: 1,
      added: 63,
      deleted: 0,
    });
    expect(parseShortstat("2 files changed, 10 insertions(+), 3 deletions(-)")).toEqual({
      files: 2,
      added: 10,
      deleted: 3,
    });
    expect(parseShortstat("1 file changed, 4 deletions(-)")).toEqual({
      files: 1,
      added: 0,
      deleted: 4,
    });
    expect(parseShortstat("nothing here")).toBeUndefined();
  });
});

describe("cleanTitle", () => {
  it("drops the task prefix, backticks and emphasis", () => {
    expect(cleanTitle("Task 4: Render the `two` lines")).toBe("Render the two lines");
    expect(cleanTitle("**Gauge** formatting")).toBe("Gauge formatting");
  });
});

describe("buildSnapshot", () => {
  const base = { now: NOW, pid: 42 };

  it("is inactive and empty when no job is active", () => {
    const s = buildSnapshot({ ...base, jobs: [rec({ id: "a", state: "passed" })] });
    expect(s).toEqual({
      version: 1,
      updatedAt: NOW.toISOString(),
      pid: 42,
      active: false,
      jobs: [],
    });
  });

  it("describes a plan with delegated steps", () => {
    const live = new Map<string, DiffStat>([["c", { files: 1, added: 5, deleted: 0 }]]);
    const s = buildSnapshot({
      ...base,
      liveDiff: live,
      jobs: [
        rec({
          id: "a",
          state: "passed",
          plan: plan(2, [2, 3, 4, 6, 7]),
          envelope: envelope(200000, "1 file changed, 1 insertion(+)"),
        }),
        rec({
          id: "b",
          state: "passed",
          plan: plan(3, [2, 3, 4, 6, 7]),
          createdAt: "2026-10-30T14:22:00.000Z",
          envelope: envelope(100000, "2 files changed, 10 insertions(+), 3 deletions(-)"),
        }),
        rec({
          id: "c",
          title: "Task 4: Render the two lines",
          plan: plan(4, [2, 3, 4, 6, 7]),
          createdAt: "2026-10-30T14:25:00.000Z",
          progress: {
            ...emptyProgress(),
            phase: "run",
            tokens: 50000,
            activity: { kind: "editing", target: "render.go", at: "2026-10-30T14:29:56.000Z" },
          },
        }),
      ],
    });
    expect(s.active).toBe(true);
    expect(s.plan).toEqual({
      file: "docs/p.md",
      steps: ["passed", "passed", "running", "pending", "pending"],
      done: 2,
      failed: 0,
      elapsedSec: 600,
      tokens: 350000,
      diff: { files: 4, added: 16, deleted: 3 },
    });
    expect(s.jobs).toEqual([
      {
        id: "c",
        step: 4,
        title: "Render the two lines",
        state: "running",
        phase: "run",
        activity: { kind: "editing", target: "render.go", at: "2026-10-30T14:29:56.000Z" },
      },
    ]);
  });

  it("lists several running jobs oldest first and drops the activity outside the run phase", () => {
    const s = buildSnapshot({
      ...base,
      jobs: [
        rec({
          id: "late",
          plan: plan(6, [2, 3, 6]),
          createdAt: "2026-10-30T14:21:00.000Z",
          progress: { ...emptyProgress(), phase: "prepare" },
        }),
        rec({
          id: "early",
          plan: plan(2, [2, 3, 6]),
          progress: {
            ...emptyProgress(),
            phase: "run",
            activity: { kind: "testing", at: "2026-10-30T14:29:00.000Z" },
          },
        }),
        rec({ id: "queued", state: "queued", plan: plan(3, [2, 3, 6]), createdAt: "2026-10-30T14:22:00.000Z" }),
      ],
    });
    expect(s.plan?.steps).toEqual(["running", "queued", "running"]);
    expect(s.jobs.map((j) => [j.id, j.state, j.phase, j.activity?.kind])).toEqual([
      ["early", "running", "run", "testing"],
      ["late", "running", "prepare", undefined],
      ["queued", "queued", "queued", undefined],
    ]);
  });

  it("treats a job without a plan as a single step", () => {
    const s = buildSnapshot({ ...base, jobs: [rec({ id: "solo" })] });
    expect(s.plan?.file).toBeNull();
    expect(s.plan?.steps).toEqual(["running"]);
    expect(s.jobs[0].step).toBeNull();
  });

  it("marks a step failed, and a passing follow-up wins over it", () => {
    const failedOnly = buildSnapshot({
      ...base,
      jobs: [
        rec({ id: "x", state: "failed", plan: plan(4, [4, 6]) }),
        rec({ id: "y", plan: plan(6, [4, 6]), createdAt: "2026-10-30T14:21:00.000Z" }),
      ],
    });
    expect(failedOnly.plan?.steps).toEqual(["failed", "running"]);
    expect(failedOnly.plan?.failed).toBe(1);

    const fixed = buildSnapshot({
      ...base,
      jobs: [
        rec({ id: "x", state: "failed", plan: plan(4, [4, 6]) }),
        rec({ id: "x2", state: "passed", plan: plan(4, [4, 6]), createdAt: "2026-10-30T14:21:00.000Z" }),
        rec({ id: "y", plan: plan(6, [4, 6]), createdAt: "2026-10-30T14:22:00.000Z" }),
      ],
    });
    expect(fixed.plan?.steps).toEqual(["passed", "running"]);
    expect(fixed.plan?.failed).toBe(0);
  });

  it("falls back to the plan file's step count, then to the steps seen", () => {
    const jobs = [
      rec({ id: "a", state: "passed", plan: plan(1) }),
      rec({ id: "b", plan: plan(2), createdAt: "2026-10-30T14:21:00.000Z" }),
    ];
    expect(buildSnapshot({ ...base, jobs, planSteps: () => 3 }).plan?.steps).toEqual([
      "passed",
      "running",
      "pending",
    ]);
    expect(buildSnapshot({ ...base, jobs }).plan?.steps).toEqual(["passed", "running"]);
  });

  it("describes only the plan of the oldest running job", () => {
    const s = buildSnapshot({
      ...base,
      jobs: [
        rec({ id: "other", state: "queued", plan: { file: "docs/other.md", step: 1 } }),
        rec({ id: "mine", plan: plan(1, [1]), createdAt: "2026-10-30T14:21:00.000Z" }),
      ],
    });
    expect(s.plan?.file).toBe("docs/p.md");
    expect(s.jobs.map((j) => j.id)).toEqual(["mine"]);
  });

  it("ignores an earlier run of the same plan", () => {
    const s = buildSnapshot({
      ...base,
      jobs: [
        rec({
          id: "old1",
          state: "passed",
          plan: plan(2, [2, 3]),
          createdAt: "2026-10-27T10:00:00.000Z",
          progress: { ...emptyProgress(), tokens: 900000 },
        }),
        rec({
          id: "old2",
          state: "passed",
          plan: plan(3, [2, 3]),
          createdAt: "2026-10-27T10:30:00.000Z",
          progress: { ...emptyProgress(), tokens: 900000 },
        }),
        rec({
          id: "new",
          plan: plan(2, [2, 3]),
          progress: { ...emptyProgress(), phase: "run", tokens: 1000 },
        }),
      ],
    });
    expect(s.plan?.steps).toEqual(["running", "pending"]);
    expect(s.plan?.done).toBe(0);
    expect(s.plan?.elapsedSec).toBe(600);
    expect(s.plan?.tokens).toBe(1000);
  });

  it("keeps the earlier jobs of the same run when the gaps are under two hours", () => {
    const s = buildSnapshot({
      ...base,
      jobs: [
        rec({
          id: "a",
          state: "passed",
          plan: plan(2, [2, 3, 4]),
          createdAt: "2026-10-30T12:30:00.000Z",
        }),
        rec({
          id: "b",
          state: "passed",
          plan: plan(3, [2, 3, 4]),
          createdAt: "2026-10-30T13:40:00.000Z",
        }),
        rec({ id: "c", plan: plan(4, [2, 3, 4]) }),
      ],
    });
    expect(s.plan?.steps).toEqual(["passed", "passed", "running"]);
    expect(s.plan?.elapsedSec).toBe(7200);
  });

  it("passes the quota through", () => {
    const quota = {
      fetchedAt: "2026-10-30T14:29:00.000Z",
      fiveHour: { remaining: 94, resetAt: "2026-10-30T17:42:00Z" },
    };
    expect(buildSnapshot({ ...base, jobs: [rec({ id: "a" })], quota }).quota).toEqual(quota);
  });
});
