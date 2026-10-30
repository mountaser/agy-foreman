import os from "node:os";
import path from "node:path";

export interface PathEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
}

const APP = "agy-foreman";

function resolveEnv(p: Partial<PathEnv> = {}): PathEnv {
  return {
    platform: p.platform ?? process.platform,
    env: p.env ?? process.env,
    home: p.home ?? os.homedir(),
  };
}

function joinFor(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32.join : path.posix.join;
}

export function stateDir(p?: Partial<PathEnv>): string {
  const { platform, env, home } = resolveEnv(p);
  if (env.FOREMAN_STATE_DIR) return env.FOREMAN_STATE_DIR;
  const join = joinFor(platform);
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), APP);
  if (platform === "darwin") return join(home, "Library", "Application Support", APP);
  return join(env.XDG_STATE_HOME || join(home, ".local", "state"), APP);
}

export function worktreeRoot(p?: Partial<PathEnv>): string {
  const e = resolveEnv(p);
  return joinFor(e.platform)(stateDir(e), "wt");
}

export function jobsDir(p?: Partial<PathEnv>): string {
  const e = resolveEnv(p);
  return joinFor(e.platform)(stateDir(e), "jobs");
}

export function statusFile(p?: Partial<PathEnv>): string {
  const e = resolveEnv(p);
  return joinFor(e.platform)(stateDir(e), "status.json");
}

export function expandHome(input: string, home: string = os.homedir()): string {
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\"))
    return path.join(home, input.slice(2)).replace(/\\/g, home.includes("\\") ? "\\" : "/");
  return input;
}
