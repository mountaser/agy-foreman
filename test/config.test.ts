import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  parseProjectConfig,
  loadRuntimeConfig,
  loadConfig,
  ConfigError,
  CONFIG_FILE,
} from "../src/config.js";

describe("parseProjectConfig", () => {
  it("applies defaults to an empty object", () => {
    const c = parseProjectConfig({});
    expect(c.model).toBe("gemini-3.8-flash-high");
    expect(c.effort).toBe("high");
    expect(c.gate).toBe("elicitation");
    expect(c.approval).toBe("per_plan");
    expect(c.maxConcurrent).toBe(2);
    expect(c.maxRunsPerHour).toBe(10);
    expect(c.refuseRatio).toBe(1.5);
    expect(c.protectedPaths).toContain("tests/**");
    expect(c.skillRoots).toEqual([".agents/skills", ".claude/skills", "~/.claude/skills"]);
    expect(c.testCommand).toBeUndefined();
    expect(c.allowedCommands).toEqual([]);
    expect(c.unknownCommands).toBe("deny");
    expect(c.allowedMcp).toEqual([]);
    expect(c.web).toBe(false);
  });

  it("validates tool-gate settings", () => {
    expect(
      parseProjectConfig({ allowed_mcp: ["github/*"], unknown_commands: "allow", web: true }),
    ).toMatchObject({ allowedMcp: ["github/*"], unknownCommands: "allow", web: true });
    expect(() => parseProjectConfig({ allowed_mcp: ["socraticode"] })).toThrow(ConfigError);
    expect(() => parseProjectConfig({ unknown_commands: "maybe" })).toThrow(ConfigError);
  });

  it("maps snake_case keys", () => {
    const c = parseProjectConfig({
      test_command: ["npm", "test"],
      setup_command: ["npm", "ci"],
      max_concurrent: 1,
      refuse_ratio: 2,
    });
    expect(c.testCommand).toEqual(["npm", "test"]);
    expect(c.setupCommand).toEqual(["npm", "ci"]);
    expect(c.maxConcurrent).toBe(1);
    expect(c.refuseRatio).toBe(2);
  });

  it("rejects efforts other than low, medium, high", () => {
    expect(() => parseProjectConfig({ effort: "max" })).toThrow(ConfigError);
    expect(() => parseProjectConfig({ effort: "xhigh" })).toThrow(/effort/);
  });

  it("accepts per_task approval and rejects the reserved auto mode", () => {
    expect(parseProjectConfig({ approval: "per_task" }).approval).toBe("per_task");
    expect(() => parseProjectConfig({ approval: "auto" })).toThrow(ConfigError);
  });

  it("rejects an empty test command and unknown gate", () => {
    expect(() => parseProjectConfig({ test_command: [] })).toThrow(ConfigError);
    expect(() => parseProjectConfig({ gate: "auto" })).toThrow(ConfigError);
  });

  it("rejects unknown keys so typos surface", () => {
    expect(() => parseProjectConfig({ tset_command: ["x"] })).toThrow(/tset_command/);
  });

  it("accepts an optional test_report path", () => {
    expect(parseProjectConfig({ test_report: "reports/junit.xml" }).testReport).toBe(
      "reports/junit.xml",
    );
    expect(parseProjectConfig({}).testReport).toBeUndefined();
  });
});

describe("loadRuntimeConfig", () => {
  it("defaults skipPermissions to false", () => {
    expect(loadRuntimeConfig({}).skipPermissions).toBe(false);
    expect(loadRuntimeConfig({ AGY_SKIP_PERMISSIONS: "true" }).skipPermissions).toBe(true);
    expect(loadRuntimeConfig({ AGY_SKIP_PERMISSIONS: "1" }).skipPermissions).toBe(false);
  });
  it("reads agy path, sandbox and timeout", () => {
    const r = loadRuntimeConfig({ AGY_PATH: "/opt/agy", AGY_SANDBOX: "true", AGY_TIMEOUT: "90" });
    expect(r).toEqual({
      agyPath: "/opt/agy",
      skipPermissions: false,
      sandbox: true,
      defaultTimeoutSec: 90,
      stallAfterSec: 300,
    });
  });
  it("reads the stall time and falls back to 300s", () => {
    expect(loadRuntimeConfig({ AGY_STALL_SEC: "120" }).stallAfterSec).toBe(120);
    expect(loadRuntimeConfig({ AGY_STALL_SEC: "0" }).stallAfterSec).toBe(300);
  });
  it("falls back to 1800s for a bad timeout", () => {
    expect(loadRuntimeConfig({ AGY_TIMEOUT: "-3" }).defaultTimeoutSec).toBe(1800);
  });
});

describe("loadConfig", () => {
  it("reads the project file from the repo root", () => {
    const seen: string[] = [];
    const cfg = loadConfig({
      repoRoot: "/repo",
      env: {},
      readFile: (p) => {
        seen.push(p);
        return JSON.stringify({ test_command: ["pytest", "-q"] });
      },
    });
    expect(seen).toEqual([path.join("/repo", CONFIG_FILE)]);
    expect(cfg.project.testCommand).toEqual(["pytest", "-q"]);
  });
  it("uses defaults when the file is missing", () => {
    const cfg = loadConfig({ repoRoot: "/repo", env: {}, readFile: () => undefined });
    expect(cfg.project.model).toBe("gemini-3.8-flash-high");
  });
  it("reports invalid JSON as ConfigError", () => {
    expect(() => loadConfig({ repoRoot: "/r", env: {}, readFile: () => "{nope" })).toThrow(
      ConfigError,
    );
  });
});
