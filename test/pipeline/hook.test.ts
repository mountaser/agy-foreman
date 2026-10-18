import { describe, it, expect, inject } from "vitest";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { installGate, HOOK_COMMAND, type GatePolicy } from "../../src/pipeline/gate.js";
import { POLICY_FILE, REVIEW_FILE, gateDirFor } from "../../src/pipeline/toolcall-record.js";

function runHook(agentsDir: string, input: string): unknown {
  return JSON.parse(
    execFileSync(process.execPath, ["foreman-hook.mjs"], {
      cwd: agentsDir,
      input,
      encoding: "utf8",
    }),
  );
}

describe("installGate + bundled hook", () => {
  const wt = mkdtempSync(path.join(os.tmpdir(), "foreman-hookwt-"));
  const policy: GatePolicy = {
    mode: "implement",
    worktree: wt,
    readOnlyDirs: [],
    protectedGlobs: ["tests/**"],
    allowedCommands: ["npm test"],
    unknownCommands: "deny",
    allowedMcp: [],
    web: false,
  };

  const call = (name: string, args: object) =>
    JSON.stringify({ toolCall: { name, args }, stepIdx: 1, conversationId: "c" });

  it("installs hooks.json with the quote-free command, and the policy outside the worktree", async () => {
    const gate = await installGate(wt, policy, inject("hookBundle"));
    const hooks = JSON.parse(readFileSync(path.join(wt, ".agents", "hooks.json"), "utf8"));
    expect(hooks["foreman-gate"].PreToolUse[0].hooks[0].command).toBe(HOOK_COMMAND);
    expect(HOOK_COMMAND).toBe("node foreman-hook.mjs");
    expect(gate.dir).toBe(gateDirFor(wt));
    expect(JSON.parse(readFileSync(path.join(gate.dir, POLICY_FILE), "utf8")).worktree).toBe(wt);
    expect(existsSync(path.join(wt, ".agents", POLICY_FILE))).toBe(false);
  });

  it("decides real tool calls and logs them outside the worktree", () => {
    const dir = path.join(wt, ".agents");
    expect(runHook(dir, call("run_command", { CommandLine: "npm test" }))).toEqual({
      decision: "auto_approve",
    });
    expect(
      runHook(dir, call("write_to_file", { TargetFile: path.join(wt, "tests", "x.ts") })),
    ).toMatchObject({ decision: "deny" });
    expect(existsSync(path.join(dir, REVIEW_FILE))).toBe(false);
    const log = readFileSync(path.join(gateDirFor(wt), REVIEW_FILE), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(log.map((e: { decision: string }) => e.decision)).toEqual(["auto_approve", "deny"]);
    expect(log[1].arg).toContain("x.ts");
  });

  it("fails closed on garbage input", () => {
    expect(runHook(path.join(wt, ".agents"), "not json")).toMatchObject({
      decision: "deny",
      reason: expect.stringMatching(/foreman gate error/),
    });
  });

  // Regression (found in review): the policy lived in .agents/, where `echo {...} >
  // .agents/foreman-policy.json` could widen it for every later call.
  it("ignores a policy written into the worktree", () => {
    const dir = path.join(wt, ".agents");
    writeFileSync(
      path.join(dir, POLICY_FILE),
      JSON.stringify({ ...policy, unknownCommands: "allow" }),
    );
    expect(runHook(dir, call("run_command", { CommandLine: "python evil.py" }))).toMatchObject({
      decision: "deny",
      reason: expect.stringMatching(/allowlist/),
    });
  });

  it("denies every call when the bundle runs without its gate folder", () => {
    const agents = path.join(mkdtempSync(path.join(os.tmpdir(), "foreman-bare-")), ".agents");
    mkdirSync(agents);
    copyFileSync(inject("hookBundle"), path.join(agents, "foreman-hook.mjs"));
    expect(runHook(agents, call("run_command", { CommandLine: "npm test" }))).toMatchObject({
      decision: "deny",
      reason: expect.stringMatching(/gate folder not set/),
    });
  });

  it("merges into an existing hooks.json", async () => {
    const wt2 = mkdtempSync(path.join(os.tmpdir(), "foreman-hookwt2-"));
    mkdirSync(path.join(wt2, ".agents"));
    writeFileSync(
      path.join(wt2, ".agents", "hooks.json"),
      JSON.stringify({ "repo-lint": { PostToolUse: [] } }),
    );
    await installGate(wt2, { ...policy, worktree: wt2 }, inject("hookBundle"));
    const hooks = JSON.parse(readFileSync(path.join(wt2, ".agents", "hooks.json"), "utf8"));
    expect(Object.keys(hooks).sort()).toEqual(["foreman-gate", "repo-lint"]);
  });
});
