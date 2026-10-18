import { describe, it, expect } from "vitest";
import { appendFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GATE_DIR_GLOBAL,
  POLICY_FILE,
  REVIEW_FILE,
  appendReview,
  gateDirFor,
  hookScript,
  readPolicy,
  readReview,
  toolSubject,
  writePolicy,
} from "../../src/pipeline/toolcall-record.js";
import type { GatePolicy } from "../../src/pipeline/gate.js";

const dir = () => mkdtempSync(path.join(os.tmpdir(), "foreman-rec-"));

describe("tool-call record", () => {
  it("keeps the file names the hook and the server agree on", () => {
    expect(POLICY_FILE).toBe("foreman-policy.json");
    expect(REVIEW_FILE).toBe("foreman-review.jsonl");
  });

  it("round-trips the policy", () => {
    const d = dir();
    const policy = { worktree: "/w", allowedCommands: ["npm test"] } as unknown as GatePolicy;
    writePolicy(d, policy);
    expect(readPolicy(d)).toEqual(policy);
  });

  it("appends review entries and reads them back in order, skipping broken lines", () => {
    const d = dir();
    expect(readReview(d)).toEqual([]);
    appendReview(d, {
      t: "1",
      name: "run_command",
      decision: "deny",
      reason: "x",
      arg: "git push",
    });
    appendFileSync(path.join(d, REVIEW_FILE), "{broken\n");
    appendReview(d, { t: "2", name: "view_file", decision: "auto_approve", arg: "src/a.ts" });
    expect(readReview(d).map((e) => e.t)).toEqual(["1", "2"]);
    expect(readReview(d)[0]).toMatchObject({ decision: "deny", arg: "git push" });
  });

  it("keeps the gate folder next to the worktree, not inside it", () => {
    const wt = path.join(os.tmpdir(), "wt", "t-1");
    expect(gateDirFor(wt)).toBe(path.resolve(wt) + ".gate");
    expect(path.relative(wt, gateDirFor(wt)).startsWith("..")).toBe(true);
  });

  it("sets the gate folder before the bundle runs, after any shebang", () => {
    const line = `globalThis.${GATE_DIR_GLOBAL} = "C:\\\\g";\n`;
    expect(hookScript("import x;\n", "C:\\g")).toBe(line + "import x;\n");
    expect(hookScript("#!/usr/bin/env node\nimport x;\n", "C:\\g")).toBe(
      "#!/usr/bin/env node\n" + line + "import x;\n",
    );
  });

  it("names what a tool call acts on with one rule", () => {
    expect(toolSubject({ CommandLine: "npm test", TargetFile: "a.ts" })).toBe("a.ts");
    expect(toolSubject({ CommandLine: "npm test" })).toBe("npm test");
    expect(toolSubject({ DirectoryPath: "src" })).toBe("src");
    expect(toolSubject({ Url: "https://x" })).toBe("https://x");
    expect(toolSubject({ Other: 5 })).toBe("5");
    expect(toolSubject({ CommandLine: "x".repeat(300) })).toHaveLength(200);
    expect(toolSubject({})).toBeUndefined();
    expect(toolSubject(undefined)).toBeUndefined();
  });
});
