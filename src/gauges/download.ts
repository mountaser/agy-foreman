import { createHash } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseChecksum } from "./asset.js";

/** The part of `fetch` this module uses, so tests can replace it. */
export type Fetch = (url: string) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;

/**
 * Downloads one release file and writes it into `dir` only if its SHA-256 matches the line in the
 * same release's `checksums.txt`. Returns the path of the written file.
 */
export async function downloadVerified(o: {
  fetch: Fetch;
  base: string;
  asset: string;
  dir: string;
}): Promise<string> {
  const sums = await o.fetch(`${o.base}/checksums.txt`);
  if (!sums.ok) throw new Error(`could not download checksums.txt (HTTP ${sums.status})`);
  const want = parseChecksum(await sums.text(), o.asset);
  if (!want) throw new Error(`no checksum is listed for ${o.asset}`);

  const bin = await o.fetch(`${o.base}/${o.asset}`);
  if (!bin.ok) throw new Error(`could not download ${o.asset} (HTTP ${bin.status})`);
  const data = Buffer.from(await bin.arrayBuffer());
  const got = createHash("sha256").update(data).digest("hex");
  if (got !== want) {
    throw new Error(`checksum mismatch for ${o.asset} (expected ${want}, got ${got})`);
  }

  const file = path.join(o.dir, o.asset.endsWith(".exe") ? "claude-gauges.exe" : "claude-gauges");
  await writeFile(file, data);
  await chmod(file, 0o755);
  return file;
}
