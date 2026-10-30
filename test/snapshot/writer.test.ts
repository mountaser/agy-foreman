import { afterEach, describe, it, expect, vi } from "vitest";
import { SnapshotWriter, type SnapshotWriterDeps } from "../../src/snapshot/writer.js";
import { emptyProgress, type JobRecord } from "../../src/jobs/store.js";
import type { Snapshot } from "../../src/snapshot/types.js";

function job(over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "a",
    kind: "implement",
    repoRoot: "/repo",
    title: "Task",
    state: "running",
    progress: { ...emptyProgress(), phase: "run" },
    createdAt: "2026-10-30T14:20:00.000Z",
    updatedAt: "2026-10-30T14:20:00.000Z",
    returnedChars: 0,
    ...over,
  };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

function make(jobs: JobRecord[], over: Partial<SnapshotWriterDeps> = {}) {
  const state = { jobs, now: Date.parse("2026-10-30T14:30:00.000Z"), lists: 0, diffs: 0 };
  const written: Snapshot[] = [];
  const deps: SnapshotWriterDeps = {
    file: "unused",
    listJobs: async () => {
      state.lists++;
      return state.jobs;
    },
    readQuota: () => undefined,
    liveDiff: async () => {
      state.diffs++;
      return { files: 1, added: 2, deleted: 0 };
    },
    planSteps: () => undefined,
    now: () => new Date(state.now),
    pid: 42,
    heartbeatMs: 1000,
    debounceMs: 200,
    write: async (_file, text) => {
      written.push(JSON.parse(text) as Snapshot);
    },
    ...over,
  };
  return { w: new SnapshotWriter(deps), state, written };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SnapshotWriter", () => {
  it("writes an active snapshot and adds the live diff once it has been measured", async () => {
    const { w, written } = make([job()]);
    await w.writeNow();
    expect(written).toHaveLength(1);
    expect(written[0].version).toBe(1);
    expect(written[0].pid).toBe(42);
    expect(written[0].active).toBe(true);
    expect(written[0].plan?.diff).toBeUndefined();
    await settle();
    await w.writeNow();
    expect(written[1].plan?.diff).toEqual({ files: 1, added: 2, deleted: 0 });
  });

  it("writes an inactive snapshot when nothing is running", async () => {
    const { w, written } = make([job({ state: "passed" })]);
    await w.writeNow();
    expect(written[0].active).toBe(false);
    expect(written[0].jobs).toEqual([]);
  });

  it("measures a running job's diff at most every five seconds", async () => {
    const { w, state } = make([job()]);
    await w.writeNow();
    await settle();
    state.now += 1000;
    await w.writeNow();
    await settle();
    expect(state.diffs).toBe(1);
    state.now += 5000;
    await w.writeNow();
    await settle();
    expect(state.diffs).toBe(2);
  });

  it("does not measure the same job twice at the same time", async () => {
    let release!: () => void;
    let calls = 0;
    const { w, state } = make([job()], {
      liveDiff: () => {
        calls++;
        return new Promise((r) => {
          release = () => r({ files: 1, added: 1, deleted: 0 });
        });
      },
    });
    await w.writeNow();
    state.now += 10_000;
    await w.writeNow();
    expect(calls).toBe(1);
    release();
  });

  it("loads the existing records once and keeps the ones it is told about", async () => {
    const { w, state, written } = make([]);
    w.notify(job());
    await w.writeNow();
    await w.writeNow();
    expect(state.lists).toBe(1);
    expect(written[1].active).toBe(true);
    expect(written[1].jobs[0].id).toBe("a");
    w.stop();
  });

  it("uses the latest state of a record it was given", async () => {
    const rec = job();
    const { w, written } = make([]);
    w.notify(rec);
    await w.writeNow();
    rec.state = "passed";
    await w.writeNow();
    expect(written[0].active).toBe(true);
    expect(written[1].active).toBe(false);
    w.stop();
  });

  it("never rejects when the job list fails", async () => {
    const { w } = make([], {
      listJobs: async () => {
        throw new Error("disk");
      },
    });
    await expect(w.writeNow()).resolves.toBeUndefined();
  });

  it("turns several notifications into one write", async () => {
    vi.useFakeTimers();
    const { w, state, written } = make([job()]);
    w.notify();
    w.notify();
    w.notify();
    await vi.advanceTimersByTimeAsync(250);
    expect(state.lists).toBe(1);
    expect(written).toHaveLength(1);
  });

  it("rewrites every second while active", async () => {
    vi.useFakeTimers();
    const { w, written } = make([job()]);
    w.start();
    await w.writeNow();
    expect(written).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3100);
    expect(written.length).toBeGreaterThanOrEqual(4);
    w.stop();
  });

  it("stops the heartbeat once a snapshot says nothing is active", async () => {
    vi.useFakeTimers();
    const rec = job();
    const { w, written } = make([rec]);
    w.start();
    await w.writeNow();
    rec.state = "passed";
    await w.writeNow();
    const count = written.length;
    expect(written[count - 1].active).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(written).toHaveLength(count);
    w.stop();
  });

  it("stops writing after stop()", async () => {
    vi.useFakeTimers();
    const { w, written } = make([job()]);
    w.start();
    await w.writeNow();
    w.stop();
    const count = written.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(written).toHaveLength(count);
  });

  it("skips heartbeat ticks while a write is still running", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let calls = 0;
    const { w } = make([job()], {
      write: () => {
        calls++;
        return calls === 1
          ? new Promise<void>((r) => {
              release = r;
            })
          : Promise.resolve();
      },
    });
    w.start();
    void w.writeNow();
    await vi.advanceTimersByTimeAsync(3500);
    expect(calls).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(1100);
    expect(calls).toBeGreaterThanOrEqual(2);
    w.stop();
  });
});
