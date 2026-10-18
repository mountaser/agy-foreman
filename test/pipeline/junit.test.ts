import { describe, it, expect } from "vitest";
import {
  contractCases,
  isCaseOf,
  parseJUnit,
  parseJUnitCases,
  type JUnitCase,
} from "../../src/pipeline/junit.js";

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="vitest tests" tests="4" failures="1" errors="0">
  <testsuite name="a.test.ts" tests="4">
    <testcase classname="a.test.ts" name="adds" time="0.01"></testcase>
    <testcase classname="a.test.ts" name="subtracts" time="0.01">
      <failure message="expected 1 to be 2" type="AssertionError">stack</failure>
    </testcase>
    <testcase classname="a.test.ts" name="todo later" time="0"><skipped/></testcase>
    <testcase classname="b.test.ts" name="boom"><error message="TypeError">x</error></testcase>
  </testsuite>
</testsuites>`;

describe("parseJUnit", () => {
  it("counts cases, failures, errors and skips", () => {
    expect(parseJUnit(XML)).toEqual({
      tests: 4,
      failures: 1,
      errors: 1,
      skipped: 1,
      failed: ["a.test.ts > subtracts", "b.test.ts > boom"],
    });
  });
  it("handles self-closing testcases and empty input", () => {
    expect(parseJUnit('<testsuite><testcase classname="x" name="y"/></testsuite>')).toMatchObject({
      tests: 1,
      failures: 0,
    });
    expect(parseJUnit("")).toEqual({ tests: 0, failures: 0, errors: 0, skipped: 0, failed: [] });
  });
});

// Shaped like vitest 3.2's report: a file that fails to import is one failing case named after it.
const VITEST = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="4" failures="2" errors="0">
    <testsuite name="test/ok.test.mjs" tests="3" failures="1" errors="0" skipped="1">
        <testcase classname="test/ok.test.mjs" name="outer &gt; inner &gt; a &gt; b" time="0.0008">
        </testcase>
        <testcase classname="test/ok.test.mjs" name="outer &gt; inner &gt; later" time="0">
            <skipped/>
        </testcase>
        <testcase classname="test/ok.test.mjs" name="fails" time="0.004">
            <failure message="expected 1 to be 2" type="AssertionError">x</failure>
        </testcase>
    </testsuite>
    <testsuite name="test/sub/missing.test.mjs" tests="1" failures="1" errors="0" skipped="0">
        <testcase classname="test/sub/missing.test.mjs" name="test/sub/missing.test.mjs" time="0">
            <failure message="Cannot find module &apos;../../src/jwt.mjs&apos;">x</failure>
        </testcase>
    </testsuite>
</testsuites>`;

const PYTEST = `<testsuites><testsuite name="pytest" tests="3">
  <testcase classname="tests.test_jwt.TestDecode" name="test_ok" file="tests/test_jwt.py"/>
  <testcase classname="tests.test_jwt_extra" name="test_other"/>
  <testcase classname="" name="tests.test_broken"><error message="collection failure">x</error></testcase>
</testsuite></testsuites>`;

const label = (c: JUnitCase) => `${c.label}: ${c.status}`;

describe("parseJUnitCases", () => {
  it("reads each case's status, decoded label and the names of its file", () => {
    const cases = parseJUnitCases(VITEST);
    expect(cases.map(label)).toEqual([
      "test/ok.test.mjs > outer > inner > a > b: passed",
      "test/ok.test.mjs > outer > inner > later: skipped",
      "test/ok.test.mjs > fails: failed",
      "test/sub/missing.test.mjs > test/sub/missing.test.mjs: failed",
    ]);
    expect(cases[0].sources).toEqual(["test/ok.test.mjs", "test/ok.test.mjs"]);
    expect(parseJUnitCases("")).toEqual([]);
  });

  it("keeps the enclosing suite's name and file, and a classname-less case's name", () => {
    const cases = parseJUnitCases(PYTEST);
    expect(cases[0].sources).toEqual(["tests/test_jwt.py", "tests.test_jwt.TestDecode", "pytest"]);
    expect(cases[2]).toMatchObject({ status: "failed", sources: ["pytest", "tests.test_broken"] });
  });
});

describe("isCaseOf", () => {
  const of = (xml: string, file: string) =>
    parseJUnitCases(xml)
      .filter((c) => isCaseOf(c, file))
      .map((c) => c.label);

  it("matches vitest paths, also through absolute file attributes and backslashes", () => {
    expect(of(VITEST, "test/sub/missing.test.mjs")).toHaveLength(1);
    expect(of(VITEST, String.raw`test\ok.test.mjs`)).toHaveLength(3);
    expect(of(VITEST, "ok.test.mjs")).toEqual([]);
    const abs = `<testsuite><testcase name="t" file="/home/u/wt/test/a.test.ts"/></testsuite>`;
    expect(of(abs, "test/a.test.ts")).toEqual(["t"]);
  });

  it("matches pytest's dotted module paths without matching longer module names", () => {
    expect(of(PYTEST, "tests/test_jwt.py")).toEqual(["tests.test_jwt.TestDecode > test_ok"]);
    expect(of(PYTEST, "tests/test_broken.py")).toEqual(["tests.test_broken"]);
  });

  it("matches Go tests by their package directory", () => {
    const go = `<testsuite name="example.com/m/auth"><testcase classname="example.com/m/auth" name="TestJWT"/></testsuite>`;
    expect(of(go, "auth/jwt_test.go")).toEqual(["example.com/m/auth > TestJWT"]);
    expect(of(go, "billing/jwt_test.go")).toEqual([]);
  });
});

describe("contractCases", () => {
  it("counts only the contract files' cases", () => {
    expect(contractCases(VITEST, ["test/sub/missing.test.mjs"])).toEqual({
      collected: 1,
      failed: ["test/sub/missing.test.mjs > test/sub/missing.test.mjs"],
      skipped: 0,
    });
    expect(contractCases(VITEST, ["test/ok.test.mjs"])).toMatchObject({ collected: 3, skipped: 1 });
    expect(contractCases(VITEST, ["test/none.test.ts"])).toEqual({
      collected: 0,
      failed: [],
      skipped: 0,
    });
  });
});
