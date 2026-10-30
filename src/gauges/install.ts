import { assetName, releaseBase } from "./asset.js";
import { downloadVerified, type Fetch } from "./download.js";
import { isOldForemanCommand } from "./settings.js";

export interface InstallGaugesDeps {
  fetch: Fetch;
  platform: NodeJS.Platform;
  arch: string;
  mkTmp(): Promise<string>;
  rmTmp(dir: string): Promise<void>;
  run(exe: string, args: string[]): Promise<number>;
  out(s: string): void;
  err(s: string): void;
  /** The command of the status line in Claude Code's settings now, if any. */
  currentCommand?: string;
}

/**
 * Downloads the claude-gauges release for this system, verifies it and runs its `install`.
 * Returns the exit code to use.
 */
export async function installGauges(
  d: InstallGaugesDeps,
  o: { force: boolean; version?: string },
): Promise<number> {
  const asset = assetName(d.platform, d.arch);
  if (!asset) {
    d.err(
      `claude-gauges has no build for ${d.platform} ${d.arch}. Install it yourself: agy-foreman statusline --manual`,
    );
    return 1;
  }

  const replacingOld = isOldForemanCommand(d.currentCommand);
  if (replacingOld) {
    d.out(
      "Replacing the old agy-foreman status line. claude-gauges saves it, and `claude-gauges uninstall` restores it.",
    );
  }
  const args = ["install", ...(o.force || replacingOld ? ["--force"] : [])];

  const dir = await d.mkTmp();
  try {
    d.out(`Downloading ${asset}...`);
    const exe = await downloadVerified({
      fetch: d.fetch,
      base: releaseBase(o.version),
      asset,
      dir,
    });
    return await d.run(exe, args);
  } catch (e) {
    d.err(`status line: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    await d.rmTmp(dir);
  }
}
