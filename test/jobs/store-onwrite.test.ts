import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyProgress, JobStore, type JobRecord } from "../../src/jobs/store.js";

function record(id: string): JobRecord {
  return {
    id,
    kind: "implement",
    repoRoot: "/repo",
    title: "Task",
    state: "running",
    progress: emptyProgress(),
    createdAt: "2026-10-30T14:00:00.000Z",
    updatedAt: "2026-10-30T14:00:00.000Z",
    returnedChars: 0,
  };
}

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "foreman-store-"));

describe("JobStore onWrite", () => {
  it("calls the callback after each write", async () => {
    const seen: string[] = [];
    const store = new JobStore(tmp(), (r) => seen.push(r.id));
    await store.write(record("a"));
    await store.write(record("b"));
    expect(seen).toEqual(["a", "b"]);
  });

  it("does not let a throwing callback break the write", async () => {
    const store = new JobStore(tmp(), () => {
      throw new Error("boom");
    });
    await store.write(record("a"));
    expect((await store.read("a"))?.id).toBe("a");
  });

  it("keeps the activity and delegate steps in the record", async () => {
    const store = new JobStore(tmp());
    const r = record("a");
    r.plan = { file: "docs/p.md", step: 4, delegateSteps: [2, 3, 4] };
    r.progress.activity = { kind: "editing", target: "render.go", at: "2026-10-30T14:00:01.000Z" };
    await store.write(r);
    const back = await store.read("a");
    expect(back?.plan?.delegateSteps).toEqual([2, 3, 4]);
    expect(back?.progress.activity?.target).toBe("render.go");
  });
});
