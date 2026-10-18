import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installGate } from "../src/pipeline/gate.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Regression: tsup code splitting once moved gate code into a shared chunk, so the hook
// copied alone into a worktree could not load and every tool call was denied.
describe("built hook bundle", () => {
  it("is self-contained and decides tool calls when copied alone", async () => {
    const out = mkdtempSync(path.join(os.tmpdir(), "foreman-dist-"));
    execFileSync(
      process.execPath,
      [path.join(root, "node_modules", "tsup", "dist", "cli-default.js"), "--out-dir", out],
      {
        cwd: root,
        stdio: "pipe",
      },
    );
    const hook = readFileSync(path.join(out, "foreman-hook.js"), "utf8");
    expect(hook).not.toMatch(/from\s+["']\.\.?\//);

    const wt = mkdtempSync(path.join(os.tmpdir(), "foreman-iso-"));
    await installGate(
      wt,
      {
        mode: "implement",
        worktree: wt,
        readOnlyDirs: [],
        protectedGlobs: [],
        allowedCommands: ["npm test"],
        unknownCommands: "deny",
        allowedMcp: [],
        web: false,
      },
      path.join(out, "foreman-hook.js"),
    );
    const decide = (name: string, args: object) =>
      JSON.parse(
        execFileSync(process.execPath, ["foreman-hook.mjs"], {
          cwd: path.join(wt, ".agents"),
          input: JSON.stringify({ toolCall: { name, args } }),
          encoding: "utf8",
        }),
      );
    expect(decide("run_command", { CommandLine: "npm test" })).toEqual({
      decision: "auto_approve",
    });
    expect(decide("run_command", { CommandLine: "git push" }).decision).toBe("deny");
  }, 60_000);
});
