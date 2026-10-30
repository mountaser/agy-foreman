import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { diffStat } from "../../src/snapshot/diff.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    stdio: "pipe",
  });

function repo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "foreman-diff-"));
  git(dir, "init", "-q");
  writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(path.join(dir, "b.txt"), "keep\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

describe("diffStat", () => {
  it("is zero for a clean tree", async () => {
    expect(await diffStat(repo())).toEqual({ files: 0, added: 0, deleted: 0 });
  });

  it("counts tracked changes and new files, ignoring task folders", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "a.txt"), "one\nTWO\nthree\nfour\n"); // +2 -1
    writeFileSync(path.join(dir, "new.go"), "package x\n\nfunc F() {}\n"); // +3, untracked
    mkdirSync(path.join(dir, ".agy-task"));
    writeFileSync(path.join(dir, ".agy-task", "brief.md"), "x\ny\n");
    mkdirSync(path.join(dir, ".agents"));
    writeFileSync(path.join(dir, ".agents", "p.json"), "{}\n");
    expect(await diffStat(dir)).toEqual({ files: 2, added: 5, deleted: 1 });
  });

  it("counts an empty new file as a file with no lines", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "empty.txt"), "");
    expect(await diffStat(dir)).toEqual({ files: 1, added: 0, deleted: 0 });
  });

  it("counts a last line without a trailing newline", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "n.txt"), "a\nb");
    expect(await diffStat(dir)).toEqual({ files: 1, added: 2, deleted: 0 });
  });

  it("counts a file over 1 MB as a file with no lines", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "big.bin"), "a\n".repeat(600_000));
    expect(await diffStat(dir)).toEqual({ files: 1, added: 0, deleted: 0 });
  });

  it("is undefined when git fails", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "foreman-nogit-"));
    mkdirSync(path.join(dir, ".git"));
    const failing = async () => ({ code: 128, stdout: "", stderr: "fatal", timedOut: false });
    expect(await diffStat(dir, failing)).toBeUndefined();
  });

  it("is undefined for a folder that is not itself a worktree", async () => {
    const dir = repo();
    const sub = path.join(dir, "sub");
    mkdirSync(sub);
    expect(await diffStat(sub)).toBeUndefined();
  });
});
