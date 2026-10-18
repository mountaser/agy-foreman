import { describe, it, expect, inject } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeGuard } from "../../src/pipeline/guard.js";
import { installGate, type GatePolicy } from "../../src/pipeline/gate.js";
import { POLICY_FILE } from "../../src/pipeline/toolcall-record.js";
import type { StreamEvent } from "../../src/agy/types.js";

const WT = path.join(os.tmpdir(), "foreman-guard-wt");
const policy: GatePolicy = {
  mode: "implement",
  worktree: WT,
  readOnlyDirs: [],
  protectedGlobs: ["tests/**"],
  allowedCommands: ["npm test"],
  unknownCommands: "deny",
  allowedMcp: [],
  web: false,
};
const tool = (
  state: string,
  toolName: string,
  toolParams: Record<string, unknown>,
): StreamEvent => ({ kind: "step", stepIndex: 1, state, stepType: "tool", toolName, toolParams });

describe("makeGuard", () => {
  const g = makeGuard(policy);
  it("ignores allowed steps, non-tool steps and ACTIVE steps", () => {
    expect(g(tool("DONE", "write_to_file", { TargetFile: path.join(WT, "src/a.ts") }))).toBeNull();
    expect(
      g({ kind: "step", stepIndex: 2, state: "DONE", stepType: "agent_response", textDelta: "x" }),
    ).toBeNull();
    expect(
      g(tool("ACTIVE", "write_to_file", { TargetFile: path.join(WT, "tests/a.ts") })),
    ).toBeNull();
    expect(g({ kind: "init", tools: [] })).toBeNull();
  });
  // Regression (found in review): a rewritten hooks.json or policy let later calls through the hook.
  it("stops the run when a tool call changed the gate's files", async () => {
    const wt = mkdtempSync(path.join(os.tmpdir(), "foreman-guardwt-"));
    const pol = { ...policy, worktree: wt };
    const gate = await installGate(wt, pol, inject("hookBundle"));
    const guard = makeGuard(pol, gate);
    const step = tool("DONE", "run_command", { CommandLine: "npm test" });
    expect(guard(step)).toBeNull();
    writeFileSync(path.join(wt, ".agents", "hooks.json"), "{}");
    expect(guard(step)).toMatch(/^guard: run_command npm test: the gate's .* changed/);
    await installGate(wt, pol, inject("hookBundle"));
    writeFileSync(path.join(gate.dir, POLICY_FILE), JSON.stringify({ ...pol, web: true }));
    expect(guard(step)).toMatch(/changed/);
  });

  it("flags executed forbidden actions", () => {
    expect(g(tool("DONE", "write_to_file", { TargetFile: path.join(WT, "tests/a.ts") }))).toMatch(
      /^guard: write_to_file .*tests.*protected/,
    );
    expect(g(tool("DONE", "run_command", { CommandLine: "git push" }))).toMatch(
      /^guard: run_command git push/,
    );
  });
});
