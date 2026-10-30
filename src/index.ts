#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { main } from "./cli.js";

process.exitCode = await main(process.argv.slice(2), {
  out: console.log,
  err: console.error,
  ask: process.stdin.isTTY
    ? async (question) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await rl.question(question);
        } finally {
          rl.close();
        }
      }
    : undefined,
  env: process.env,
  cwd: process.cwd(),
});
