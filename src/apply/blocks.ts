// Finds the files a plan step spells out in full, so `agy-foreman apply` can write them itself.
// Version 1 only creates files: anything that reads like an edit to an existing file is a problem.

export interface PlannedFile {
  path: string;
  content: string;
}

export interface BlockProblem {
  /** 1-based index of the fenced block in the step; 0 when the problem is not about one block. */
  block: number;
  reason: string;
}

interface Block {
  index: number;
  /** The nearest non-blank line before the opening fence. */
  before: string;
  lines: string[];
}

const INSTRUCTION = /\b(append|add to|insert|replace|modify)\b/i;
const PATH_COMMENT = /^(?:\/\/|#(?!!)|--|<!--)\s*(\S+?)\s*(?:-->)?\s*$/;

function looksLikePath(token: string): boolean {
  return /^[^\s`]+$/.test(token) && (token.includes("/") || /\.\w+$/.test(token));
}

function readBlocks(text: string): Block[] {
  const lines = text.split(/\r?\n/);
  const blocks: Block[] = [];
  let before = "";
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)```/.exec(lines[i]);
    if (!open) {
      if (lines[i].trim() !== "") before = lines[i];
      continue;
    }
    const indent = open[1].length;
    const body: string[] = [];
    let closed = false;
    for (i++; i < lines.length; i++) {
      if (/^\s*```\s*$/.test(lines[i])) {
        closed = true;
        break;
      }
      const lead = /^\s*/.exec(lines[i])![0].length;
      body.push(lines[i].slice(Math.min(indent, lead)));
    }
    if (!closed) break;
    blocks.push({ index: blocks.length + 1, before, lines: body });
    before = lines[i];
  }
  return blocks;
}

function pathProblem(p: string): string | undefined {
  if (p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p)) {
    return `path is outside the repo: ${p}`;
  }
  if (p.includes("\\") || p.split("/").includes("..")) {
    return `path is outside the repo: ${p}`;
  }
  if (p.startsWith(".git/")) return `path is inside .git: ${p}`;
  return undefined;
}

/**
 * The files a step creates, taken from its fenced blocks. A block belongs to the backticked path on
 * the line before it, or to a path comment on its first line (which is then removed). A block with
 * no path is an example and is ignored. `_files` is the list `parsePlanStep` found; it is only
 * there so callers pass the step the same way the plan parser reads it.
 */
export function planFiles(
  stepText: string,
  _files: string[],
): { files: PlannedFile[]; problems: BlockProblem[] } {
  const problems: BlockProblem[] = [];
  const candidates: { block: number; path: string; content: string }[] = [];

  for (const b of readBlocks(stepText)) {
    const word = INSTRUCTION.exec(b.before);
    if (word) {
      problems.push({ block: b.index, reason: `ambiguous instruction: ${word[1].toLowerCase()}` });
      continue;
    }
    let target: string | undefined;
    let body = b.lines;
    const comment = b.lines.length > 0 ? PATH_COMMENT.exec(b.lines[0]) : null;
    if (comment && looksLikePath(comment[1])) {
      target = comment[1];
      body = b.lines.slice(1);
    } else {
      const named = [...b.before.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter(looksLikePath);
      if (named.length === 1) target = named[0];
    }
    if (target === undefined) continue;
    const bad = pathProblem(target);
    if (bad) {
      problems.push({ block: b.index, reason: bad });
      continue;
    }
    candidates.push({ block: b.index, path: target, content: body.join("\n") + "\n" });
  }

  const files: PlannedFile[] = [];
  for (const c of candidates) {
    if (candidates.filter((o) => o.path === c.path).length > 1) {
      problems.push({ block: c.block, reason: `two blocks for one path: ${c.path}` });
    } else {
      files.push({ path: c.path, content: c.content });
    }
  }
  problems.sort((a, b) => a.block - b.block);
  return { files, problems };
}
