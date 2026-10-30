import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { downloadVerified, type Fetch } from "../../src/gauges/download.js";

const BASE = "https://example.test/rel";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function fakeFetch(files: Record<string, string>): { fetch: Fetch; urls: string[] } {
  const urls: string[] = [];
  const fetch: Fetch = async (url) => {
    urls.push(url);
    const body = files[url];
    return {
      ok: body !== undefined,
      status: body !== undefined ? 200 : 404,
      arrayBuffer: async () => new TextEncoder().encode(body ?? "").buffer as ArrayBuffer,
      text: async () => body ?? "",
    };
  };
  return { fetch, urls };
}

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "foreman-dl-"));

describe("downloadVerified", () => {
  it("writes the file when the checksum matches", async () => {
    const dir = tmp();
    const { fetch, urls } = fakeFetch({
      [`${BASE}/checksums.txt`]: `${sha("binary")}  claude-gauges_linux_amd64\n`,
      [`${BASE}/claude-gauges_linux_amd64`]: "binary",
    });
    const file = await downloadVerified({
      fetch,
      base: BASE,
      asset: "claude-gauges_linux_amd64",
      dir,
    });
    expect(file).toBe(path.join(dir, "claude-gauges"));
    expect(readFileSync(file, "utf8")).toBe("binary");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o111).not.toBe(0);
    expect(urls.every((u) => u.startsWith(BASE + "/"))).toBe(true);
  });

  it("names a Windows file with .exe", async () => {
    const dir = tmp();
    const { fetch } = fakeFetch({
      [`${BASE}/checksums.txt`]: `${sha("w")}  claude-gauges_windows_amd64.exe\n`,
      [`${BASE}/claude-gauges_windows_amd64.exe`]: "w",
    });
    const file = await downloadVerified({
      fetch,
      base: BASE,
      asset: "claude-gauges_windows_amd64.exe",
      dir,
    });
    expect(path.basename(file)).toBe("claude-gauges.exe");
  });

  it("refuses a file whose checksum differs and writes nothing", async () => {
    const dir = tmp();
    const { fetch } = fakeFetch({
      [`${BASE}/checksums.txt`]: `${sha("good")}  claude-gauges_linux_amd64\n`,
      [`${BASE}/claude-gauges_linux_amd64`]: "tampered",
    });
    await expect(
      downloadVerified({ fetch, base: BASE, asset: "claude-gauges_linux_amd64", dir }),
    ).rejects.toThrow(/checksum mismatch for claude-gauges_linux_amd64/);
    expect(existsSync(path.join(dir, "claude-gauges"))).toBe(false);
  });

  it("refuses when the checksum list has no line for the file", async () => {
    const { fetch } = fakeFetch({
      [`${BASE}/checksums.txt`]: `${sha("x")}  claude-gauges_darwin_arm64\n`,
      [`${BASE}/claude-gauges_linux_amd64`]: "x",
    });
    await expect(
      downloadVerified({ fetch, base: BASE, asset: "claude-gauges_linux_amd64", dir: tmp() }),
    ).rejects.toThrow("no checksum is listed for claude-gauges_linux_amd64");
  });

  it("reports failed downloads with the HTTP status", async () => {
    const none = fakeFetch({});
    await expect(
      downloadVerified({
        fetch: none.fetch,
        base: BASE,
        asset: "claude-gauges_linux_amd64",
        dir: tmp(),
      }),
    ).rejects.toThrow("could not download checksums.txt (HTTP 404)");

    const noBinary = fakeFetch({
      [`${BASE}/checksums.txt`]: `${sha("x")}  claude-gauges_linux_amd64\n`,
    });
    await expect(
      downloadVerified({
        fetch: noBinary.fetch,
        base: BASE,
        asset: "claude-gauges_linux_amd64",
        dir: tmp(),
      }),
    ).rejects.toThrow("could not download claude-gauges_linux_amd64 (HTTP 404)");
  });

  it("lets a failing fetch through", async () => {
    const fetch: Fetch = async () => {
      throw new Error("offline");
    };
    await expect(
      downloadVerified({ fetch, base: BASE, asset: "claude-gauges_linux_amd64", dir: tmp() }),
    ).rejects.toThrow("offline");
  });
});
