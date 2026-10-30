import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];
export const CONFIG_FILE = ".agy-foreman.json";
/** Shown wherever an implement job cannot run because the repo has no `test_command`. */
export const MISSING_TEST_COMMAND = `config.test_command is required for implement jobs. Create ${CONFIG_FILE} (see README, "Configuration").`;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const command = z.array(z.string().min(1)).min(1);

const projectSchema = z
  .object({
    test_command: command.optional(),
    setup_command: command.optional(),
    test_report: z.string().min(1).optional(),
    protected_paths: z
      .array(z.string().min(1))
      .default([
        "tests/**",
        "test/**",
        "**/test_*.py",
        "**/*_test.*",
        "**/*.spec.*",
        "**/*.test.*",
        "**/conftest.py",
      ]),
    model: z.string().min(1).default("gemini-3.8-flash-high"),
    effort: z.enum(EFFORTS).default("high"),
    gate: z.enum(["elicitation", "client"]).default("elicitation"),
    // "auto" is reserved for a future fully automatic mode and deliberately rejected in v0.1.
    approval: z.enum(["per_plan", "per_task"]).default("per_plan"),
    max_concurrent: z.number().int().min(1).max(8).default(2),
    max_runs_per_hour: z.number().int().min(1).default(10),
    refuse_ratio: z.number().min(1).default(1.5),
    skill_roots: z
      .array(z.string().min(1))
      .default([".agents/skills", ".claude/skills", "~/.claude/skills"]),
    allowed_commands: z.array(z.string().min(1)).default([]),
    unknown_commands: z.enum(["ask_user", "deny", "allow"]).default("deny"),
    allowed_mcp: z
      .array(z.string().regex(/^[^/]+\/[^/]+$/, "use server/tool or server/*"))
      .default([]),
    web: z.boolean().default(false),
  })
  .strict();

export interface ProjectConfig {
  testCommand?: string[];
  setupCommand?: string[];
  testReport?: string;
  protectedPaths: string[];
  model: string;
  effort: Effort;
  gate: "elicitation" | "client";
  approval: "per_plan" | "per_task";
  maxConcurrent: number;
  maxRunsPerHour: number;
  refuseRatio: number;
  skillRoots: string[];
  allowedCommands: string[];
  unknownCommands: "ask_user" | "deny" | "allow";
  allowedMcp: string[];
  web: boolean;
}

export interface RuntimeConfig {
  agyPath: string;
  skipPermissions: boolean;
  sandbox: boolean;
  defaultTimeoutSec: number;
}

export interface Config {
  project: ProjectConfig;
  runtime: RuntimeConfig;
}

export function parseProjectConfig(raw: unknown): ProjectConfig {
  const parsed = projectSchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map(
        (i) =>
          `${i.path.join(".") || "(root)"}: ${i.message}${"keys" in i ? ` ${(i as { keys: string[] }).keys.join(", ")}` : ""}`,
      )
      .join("; ");
    throw new ConfigError(`Invalid ${CONFIG_FILE}: ${msg}`);
  }
  const p = parsed.data;
  return {
    ...(p.test_command ? { testCommand: p.test_command } : {}),
    ...(p.setup_command ? { setupCommand: p.setup_command } : {}),
    ...(p.test_report ? { testReport: p.test_report } : {}),
    protectedPaths: p.protected_paths,
    model: p.model,
    effort: p.effort,
    gate: p.gate,
    approval: p.approval,
    maxConcurrent: p.max_concurrent,
    maxRunsPerHour: p.max_runs_per_hour,
    refuseRatio: p.refuse_ratio,
    skillRoots: p.skill_roots,
    allowedCommands: p.allowed_commands,
    unknownCommands: p.unknown_commands,
    allowedMcp: p.allowed_mcp,
    web: p.web,
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function loadRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): RuntimeConfig {
  return {
    agyPath: env.AGY_PATH || "agy",
    skipPermissions: env.AGY_SKIP_PERMISSIONS === "true",
    sandbox: env.AGY_SANDBOX === "true",
    defaultTimeoutSec: positiveInt(env.AGY_TIMEOUT, 1800),
  };
}

function defaultReadFile(p: string): string | undefined {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

export function loadConfig(opts: {
  repoRoot?: string;
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string | undefined;
}): Config {
  const read = opts.readFile ?? defaultReadFile;
  let raw: unknown = {};
  if (opts.repoRoot) {
    const text = read(path.join(opts.repoRoot, CONFIG_FILE));
    if (text !== undefined) {
      try {
        raw = JSON.parse(text);
      } catch (e) {
        throw new ConfigError(`Invalid ${CONFIG_FILE}: ${(e as Error).message}`);
      }
    }
  }
  return { project: parseProjectConfig(raw), runtime: loadRuntimeConfig(opts.env ?? process.env) };
}
