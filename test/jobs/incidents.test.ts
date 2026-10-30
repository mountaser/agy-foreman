import { describe, it, expect } from "vitest";
import { classifyIncident } from "../../src/jobs/incidents.js";
import type { Envelope } from "../../src/pipeline/index.js";

const base: Envelope = {
  jobId: "t-1",
  kind: "implement",
  state: "failed",
  branch: "agy/t-1",
  worktreePath: "/w",
  baseSha: "b",
  untrustedReport: "",
  deniedCommands: [],
  guardEvents: [],
  skillsUsed: [],
  model: "gemini-3.8-flash-high",
  durationSec: 1,
};
const verify = (o: object) => ({
  exitCode: 1,
  timedOut: false,
  passed: false,
  newSkips: 0,
  fewerTests: false,
  protectedRestored: [],
  tamper: [],
  auditFlags: [],
  failures: [],
  outputTail: "",
  ...o,
});
const cat = (e: Partial<Envelope>, hadParent = false) =>
  classifyIncident({ ...base, ...e } as Envelope, { hadParent })?.category ?? null;

describe("classifyIncident", () => {
  it("ignores clean first-try passes and cancellations", () => {
    expect(cat({ state: "passed" })).toBeNull();
    expect(cat({ state: "cancelled" })).toBeNull();
  });
  it("flags passes that needed a follow-up", () => {
    expect(cat({ state: "passed" }, true)).toBe("brief_missing_context");
  });
  it("classifies guard violations", () => {
    expect(
      cat({
        state: "guard_violation",
        guardEvents: ["guard: write_to_file tests/a.ts: protected path"],
      }),
    ).toBe("protected_file_attempt");
    expect(
      cat({
        state: "guard_violation",
        guardEvents: ["guard: run_command git push: Dangerous command"],
      }),
    ).toBe("scope_creep");
  });
  it("detects tampering signals", () => {
    expect(cat({ verify: verify({ protectedRestored: ["test/a.test.ts"] }) as never })).toBe(
      "test_tampering",
    );
    expect(cat({ verify: verify({ auditFlags: ["skip"] }) as never })).toBe("test_tampering");
    expect(cat({ verify: verify({ newSkips: 1 }) as never })).toBe("test_tampering");
  });
  it("maps quota, timeout, refusals and errors", () => {
    expect(cat({ state: "quota" })).toBe("quota");
    expect(cat({ state: "timeout" })).toBe("timeout_no_progress");
    expect(cat({ state: "timeout", diffStat: " a.ts | 2 +-" })).toBe("timeout_with_work");
    expect(cat({ state: "refused", reason: "contract tests already pass on base" })).toBe(
      "contract_too_weak",
    );
    expect(cat({ state: "refused", reason: "skill not found: tdd" })).toBe("skill_mismatch");
    expect(cat({ state: "refused", reason: "no test_command configured" })).toBe(
      "wrong_or_missing_gate",
    );
    expect(cat({ state: "error", reason: "setup_command failed (exit 1): x" })).toBe("env_setup");
    expect(cat({ state: "error", reason: "agy returned an empty response" })).toBe("agy_error");
  });
  it("classifies failures by evidence", () => {
    expect(cat({ deniedCommands: ["python x.py"], verify: verify({}) as never })).toBe(
      "wrong_or_missing_gate",
    );
    const big =
      Array.from({ length: 16 }, (_, i) => ` src/f${i}.ts | 1 +`).join("\n") +
      "\n 16 files changed";
    expect(cat({ diffStat: big, verify: verify({}) as never })).toBe("task_too_big");
    const inc = classifyIncident(
      { ...base, verify: verify({ failures: ["a > b", "c > d", "e > f", "g > h"] }) as never },
      { hadParent: false },
    );
    expect(inc?.category).toBe("brief_missing_context");
    expect(inc?.evidence).toContain("a > b");
    expect(inc?.evidence).not.toContain("g > h");
  });
});

describe("missing config", () => {
  it("labels the missing test_command refusal as missing_config", async () => {
    const { MISSING_TEST_COMMAND } = await import("../../src/config.js");
    expect(cat({ state: "refused", reason: MISSING_TEST_COMMAND })).toBe("missing_config");
  });
});
