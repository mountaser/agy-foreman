import { describe, expect, it } from "vitest";
import { extractJsonObject } from "../../src/pipeline/json-extract.js";

const obj = { summary: "s", citations: [{ path: "a.ts", line: 1, claim: "c" }] };
const json = JSON.stringify(obj);

describe("extractJsonObject", () => {
  it("parses plain JSON", () => {
    expect(extractJsonObject(json)).toEqual(obj);
  });
  it("finds JSON followed by prose, which is what Gemini returned", () => {
    expect(
      extractJsonObject(json + "\nHere are the findings:\n```js\nexport const a = 1;\n```"),
    ).toEqual(obj);
  });
  it("finds JSON after prose", () => {
    expect(extractJsonObject("Result:\n" + json + "\nDone.")).toEqual(obj);
  });
  it("prefers a json fence and skips fences of other languages", () => {
    const text = "```javascript\nconst x = {a: 1};\n```\n```json\n" + json + "\n```";
    expect(extractJsonObject(text)).toEqual(obj);
  });
  it("handles braces and escaped quotes inside strings", () => {
    const tricky = { summary: 'has } brace and "quote" and {nested}', citations: [] };
    expect(extractJsonObject("x " + JSON.stringify(tricky) + " y")).toEqual(tricky);
  });
  it("skips a non-JSON brace pair before the real object", () => {
    expect(extractJsonObject("use {braces} like this: " + json)).toEqual(obj);
  });
  it("returns undefined when there is no object", () => {
    expect(extractJsonObject("no json here")).toBeUndefined();
    expect(extractJsonObject("[1,2,3]")).toBeUndefined();
    expect(extractJsonObject("{ broken")).toBeUndefined();
  });
});

describe("extractJsonObject with an accept rule", () => {
  const good = (v: Record<string, unknown>) => typeof v.summary === "string";
  it("skips an object of another shape and takes the one that fits", () => {
    const text = '{"findings":[]}\n```json\n{"summary":"yes","citations":[]}\n```';
    expect(extractJsonObject(text, good)).toEqual({ summary: "yes", citations: [] });
  });
  it("prefers the leading answer over a later example of the same shape", () => {
    const text = '{"summary":"first"} then {"summary":"second"}';
    expect(extractJsonObject(text, good)).toEqual({ summary: "first" });
  });
  it("returns undefined when nothing fits", () => {
    expect(extractJsonObject('{"findings":[]}', good)).toBeUndefined();
  });
});
