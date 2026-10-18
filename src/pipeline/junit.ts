import path from "node:path";

export interface TestCounts {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  failed: string[];
}

export function parseJUnit(xml: string): TestCounts {
  const result: TestCounts = {
    tests: 0,
    failures: 0,
    errors: 0,
    skipped: 0,
    failed: [],
  };

  if (!xml || !xml.trim()) {
    return result;
  }

  const testcaseRegex = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gi;
  let match: RegExpExecArray | null;

  while ((match = testcaseRegex.exec(xml)) !== null) {
    result.tests++;
    const attrs = match[1] || "";
    const body = match[2] || "";

    const classnameMatch = attrs.match(/\bclassname=["']([^"']*)["']/i);
    const nameMatch = attrs.match(/\bname=["']([^"']*)["']/i);

    const classname = classnameMatch ? classnameMatch[1].trim() : "";
    const name = nameMatch ? nameMatch[1].trim() : "";

    const label = classname && name ? `${classname} > ${name}` : name || classname;

    const hasFailure = /<failure\b/i.test(body);
    const hasError = /<error\b/i.test(body);
    const hasSkipped = /<skipped\b/i.test(body);

    if (hasFailure) {
      result.failures++;
    }
    if (hasError) {
      result.errors++;
    }
    if (hasFailure || hasError) {
      result.failed.push(label);
    }
    if (hasSkipped) {
      result.skipped++;
    }
  }

  return result;
}

export interface JUnitCase {
  label: string;
  status: "passed" | "failed" | "skipped";
  /** What may name the case's test file: its file and classname attributes, the enclosing
   *  testsuites' names and files, and its name when it has no classname (pytest collection
   *  errors are `<testcase classname="" name="tests.test_x">`). */
  sources: string[];
}

const ATTRS = `((?:[^>"']|"[^"]*"|'[^']*')*?)`;
const SUITE_OR_CASE = new RegExp(
  `<testsuite\\b${ATTRS}(\\/?)>|<\\/testsuite\\s*>|<testcase\\b${ATTRS}(?:\\/>|>([\\s\\S]*?)<\\/testcase\\s*>)`,
  "gi",
);

function attr(attrs: string, name: string): string {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  const raw = (m?.[1] ?? m?.[2] ?? "").trim();
  return raw
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Every test case in a JUnit report, with what it says about the file it came from. */
export function parseJUnitCases(xml: string): JUnitCase[] {
  const cases: JUnitCase[] = [];
  const suites: string[][] = [];
  for (const m of (xml ?? "").matchAll(SUITE_OR_CASE)) {
    if (m[0].startsWith("</")) {
      suites.pop();
    } else if (m[3] === undefined) {
      if (m[2] !== "/") suites.push([attr(m[1], "name"), attr(m[1], "file")]);
    } else {
      const classname = attr(m[3], "classname");
      const name = attr(m[3], "name");
      const body = m[4] ?? "";
      cases.push({
        label: classname && name ? `${classname} > ${name}` : name || classname,
        status: /<(failure|error)\b/i.test(body)
          ? "failed"
          : /<skipped\b/i.test(body)
            ? "skipped"
            : "passed",
        sources: [attr(m[3], "file"), classname, ...suites.flat(), classname ? "" : name].filter(
          Boolean,
        ),
      });
    }
  }
  return cases;
}

/**
 * Whether a case came from a test file, by any of the names reports use for it: the path itself
 * (vitest's classname, or the end of an absolute file attribute), the dotted module path (pytest:
 * `tests/test_jwt.py` → `tests.test_jwt.TestJwt`), or for Go the package directory.
 */
export function isCaseOf(c: JUnitCase, testFile: string): boolean {
  const norm = (s: string) => {
    const p = s.replace(/\\/g, "/").replace(/^\.\//, "");
    return process.platform === "win32" ? p.toLowerCase() : p;
  };
  const file = norm(testFile);
  const dotted = file.replace(/\.[^./]+$/, "").replace(/\//g, ".");
  const goDir = file.endsWith("_test.go") && file.includes("/") ? path.posix.dirname(file) : "";
  return c.sources.some((raw) => {
    const s = norm(raw);
    return (
      s === file ||
      (/^([a-z]:)?\//i.test(s) && s.endsWith("/" + file)) ||
      s === dotted ||
      s.startsWith(dotted + ".") ||
      (goDir !== "" && (s === goDir || s.endsWith("/" + goDir)))
    );
  });
}

export interface ContractCases {
  /** Cases from the contract test files. */
  collected: number;
  failed: string[];
  skipped: number;
}

/** The contract tests' own cases in a report: red means some failed, green means all passed. */
export function contractCases(xml: string, testFiles: string[]): ContractCases {
  const cases = parseJUnitCases(xml).filter((c) => testFiles.some((f) => isCaseOf(c, f)));
  return {
    collected: cases.length,
    failed: cases.filter((c) => c.status === "failed").map((c) => c.label),
    skipped: cases.filter((c) => c.status === "skipped").length,
  };
}
