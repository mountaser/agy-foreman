export const GAUGES_REPO = "mountaser/claude-gauges";

/** The release file for a platform and CPU as Node names them, or undefined when there is none. */
export function assetName(platform: NodeJS.Platform, arch: string): string | undefined {
  const os =
    platform === "win32"
      ? "windows"
      : platform === "darwin"
        ? "darwin"
        : platform === "linux"
          ? "linux"
          : undefined;
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : undefined;
  if (!os || !cpu) return undefined;
  return `claude-gauges_${os}_${cpu}${os === "windows" ? ".exe" : ""}`;
}

/** Where a release's files are downloaded from. The latest release unless a tag is given. */
export function releaseBase(version?: string): string {
  return version
    ? `https://github.com/${GAUGES_REPO}/releases/download/${version}`
    : `https://github.com/${GAUGES_REPO}/releases/latest/download`;
}

/** The SHA-256 of one file from a `checksums.txt` (`<hex>  <name>` per line), lower case. */
export function parseChecksum(text: string, asset: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m && m[2] === asset) return m[1].toLowerCase();
  }
  return undefined;
}
