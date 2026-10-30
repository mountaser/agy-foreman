import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function claudeSettingsPath(env: NodeJS.ProcessEnv): string {
  if (env.FOREMAN_CLAUDE_SETTINGS) return env.FOREMAN_CLAUDE_SETTINGS;
  const home = env.USERPROFILE || env.HOME || os.homedir();
  return path.join(home, ".claude", "settings.json");
}

/** The command of the status line in Claude Code's settings, or undefined when there is none. */
export async function currentStatusLineCommand(file: string): Promise<string | undefined> {
  try {
    const text = (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
    const cmd = (JSON.parse(text) as { statusLine?: { command?: unknown } }).statusLine?.command;
    return typeof cmd === "string" ? cmd : undefined;
  } catch {
    return undefined;
  }
}

/** True for the command older agy-foreman versions installed: node ".../dist/statusline.js". */
export function isOldForemanCommand(cmd: string | undefined): boolean {
  return !!cmd && /statusline(\.js")?$/.test(cmd.trim());
}
