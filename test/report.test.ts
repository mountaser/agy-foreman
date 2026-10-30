import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "../src/jobs/ledger.js";
import { buildReport } from "../src/report.js";

const entry = (o: Partial<LedgerEntry>): LedgerEntry => ({
  jobId: "t-1",
  kind: "implement",
  state: "passed",
  durationSec: 60,
  returnedTokens: 100,
  usageTotal: 1000,
  at: "2026-10-20T10:00:00.000Z",
  ...o,
});

const lines = (text: string): string[] => text.split("\n");

describe("buildReport", () => {
  it("says no jobs for an empty ledger", () => {
    expect(buildReport([], [])).toBe("no jobs\n");
  });

  it("counts jobs, Gemini tokens and minutes per state", () => {
    const text = buildReport(
      [
        entry({ jobId: "t-1", state: "passed", usageTotal: 1000, durationSec: 60 }),
        entry({ jobId: "t-2", state: "passed", usageTotal: 3000, durationSec: 120 }),
        entry({ jobId: "t-3", state: "timeout", usageTotal: 5000, durationSec: 1800 }),
      ],
      [],
    );
    expect(text).toMatch(/^jobs: 3$/m);
    expect(text).toMatch(/^passed\s+2\s+4,000\s+3\.0$/m);
    expect(text).toMatch(/^timeout\s+1\s+5,000\s+30\.0$/m);
  });

  it("treats a missing usageTotal as 0", () => {
    const text = buildReport(
      [entry({ state: "refused", usageTotal: undefined, durationSec: 0 })],
      [],
    );
    expect(text).toMatch(/^refused\s+1\s+0\s+0\.0$/m);
  });

  it("filters by --since", () => {
    const text = buildReport(
      [
        entry({ jobId: "t-old", at: "2026-10-01T00:00:00.000Z" }),
        entry({ jobId: "t-new", at: "2026-10-25T00:00:00.000Z" }),
      ],
      [],
      { since: new Date("2026-10-20T00:00:00.000Z") },
    );
    expect(text).toMatch(/^jobs: 1 \(since 2026-10-20\)$/m);
  });

  it("counts incident categories", () => {
    const inc = (category: "missing_config" | "agy_error") => ({ category, evidence: "x" });
    const text = buildReport(
      [
        entry({ jobId: "t-1", state: "refused", incident: inc("missing_config") }),
        entry({ jobId: "t-2", state: "refused", incident: inc("missing_config") }),
        entry({ jobId: "t-3", state: "error", incident: inc("agy_error") }),
      ],
      [],
    );
    expect(text).toMatch(/^incidents: missing_config=2 agy_error=1$/m);
  });

  it("reports the median and max orchestrator characters per job", () => {
    const text = buildReport(
      [entry({ jobId: "t-1" })],
      [
        { id: "t-1", returnedChars: 1000 },
        { id: "t-2", returnedChars: 3000 },
        { id: "t-3", returnedChars: 8000 },
      ],
    );
    expect(text).toMatch(/^orchestrator chars per job: median 3,000 max 8,000$/m);
  });

  it("lists the five costliest non-passed jobs with their estimate reasons", () => {
    const failed = (n: number, usage: number) =>
      entry({
        jobId: `t-f${n}`,
        state: "failed",
        usageTotal: usage,
        estimate: { directTokens: 1, delegateOverheadTokens: 1, reason: `reason ${n}` },
      });
    const text = buildReport(
      [
        entry({ jobId: "t-ok", state: "passed", usageTotal: 99999 }),
        failed(1, 100),
        failed(2, 600),
        failed(3, 300),
        failed(4, 500),
        failed(5, 200),
        failed(6, 400),
      ],
      [],
    );
    const out = lines(text);
    const at = out.findIndex((l) => l.startsWith("costliest non-passed:"));
    expect(at).toBeGreaterThan(-1);
    const rows = out.slice(at + 1).filter((l) => l.trim() !== "");
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatch(/t-f2\s+failed\s+600\s+reason 2/);
    expect(rows[4]).toMatch(/t-f5\s+failed\s+200\s+reason 5/);
    expect(text).not.toContain("t-ok");
    expect(text).not.toContain("t-f1 ");
  });

  it("stays under 40 lines", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      entry({ jobId: `t-${i}`, state: "failed", usageTotal: i }),
    );
    expect(lines(buildReport(many, [])).length).toBeLessThan(40);
  });
});
