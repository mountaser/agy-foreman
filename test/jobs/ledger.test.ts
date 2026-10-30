import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ledger, type LedgerEntry } from "../../src/jobs/ledger.js";

const e = (o: Partial<LedgerEntry>): LedgerEntry => ({
  jobId: "j",
  kind: "implement",
  state: "passed",
  durationSec: 10,
  returnedTokens: 0,
  at: "2026-10-17T10:00:00Z",
  ...o,
});

describe("Ledger", () => {
  it("appends, reads, and computes medians, calibration and stats", async () => {
    const l = new Ledger(
      path.join(mkdtempSync(path.join(os.tmpdir(), "foreman-led-")), "ledger.jsonl"),
    );
    expect(await l.medianRunSec("implement")).toBeUndefined();
    expect(await l.calibration()).toEqual({ samples: 0 });
    await l.append(
      e({
        runSec: 100,
        estimate: { directTokens: 10000, delegateOverheadTokens: 4000, reason: "" },
        returnedTokens: 6000,
      }),
    );
    await l.append(
      e({
        runSec: 300,
        estimate: { directTokens: 10000, delegateOverheadTokens: 2000, reason: "" },
        returnedTokens: 2000,
        state: "failed",
      }),
    );
    await l.append(
      e({
        runSec: 200,
        kind: "explore",
        returnedTokens: 500,
        usageTotal: 1000,
        at: "2026-10-16T10:00:00Z",
      }),
    );
    expect((await l.entries()).length).toBe(3);
    // Only the passed run counts; the failed 300 s one says nothing about how long a pass takes.
    expect(await l.medianRunSec("implement")).toBe(100);
    expect(await l.medianRunSec("explore")).toBe(200);
    expect(await l.calibration()).toEqual({ samples: 2, ratio: 1.25 });
    expect(await l.stats(new Date("2026-10-17T00:00:00Z"))).toEqual({
      jobs: 2,
      passed: 1,
      tokens: 0,
    });
  });
});

describe("passedRunStats", () => {
  it("counts and takes the median of passed runs only", async () => {
    const l = new Ledger(path.join(mkdtempSync(path.join(os.tmpdir(), "foreman-led-")), "l.jsonl"));
    await l.append(e({ runSec: 100, state: "passed" }));
    await l.append(e({ runSec: 300, state: "passed" }));
    await l.append(e({ runSec: 1800, state: "timeout" }));
    await l.append(e({ runSec: 0.05, state: "refused" }));
    expect(await l.passedRunStats("implement")).toEqual({ median: 200, count: 2 });
    expect(await l.passedRunStats("explore")).toEqual({ median: undefined, count: 0 });
  });
});
