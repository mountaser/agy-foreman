export const PROMPT = `Status line

claude-gauges shows your jobs, the Gemini quota, your Claude limits and the cache timer
under the Claude Code prompt.

  [1] Install claude-gauges (downloads the latest release from GitHub and checks its SHA-256)
  [2] I will do it myself (prints the commands)
  [3] Skip
`;

export const MANUAL = `Install claude-gauges yourself:

  macOS, Linux, WSL:   curl -fsSL https://raw.githubusercontent.com/mountaser/claude-gauges/main/install.sh | bash
  Windows PowerShell:  irm https://raw.githubusercontent.com/mountaser/claude-gauges/main/install.ps1 | iex

Then restart Claude Code. More: https://github.com/mountaser/claude-gauges`;

export type Choice = "install" | "manual" | "skip";

/** Reads the answer to the prompt. An empty answer skips; an unknown one is undefined. */
export function parseChoice(answer: string): Choice | undefined {
  switch (answer.trim().toLowerCase()) {
    case "1":
    case "i":
    case "install":
      return "install";
    case "2":
    case "m":
    case "manual":
      return "manual";
    case "3":
    case "s":
    case "skip":
    case "":
      return "skip";
    default:
      return undefined;
  }
}
