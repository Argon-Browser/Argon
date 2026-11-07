// SPDX-License-Identifier: MIT
/**
 * Unit test runner.
 *
 * `node --test <directory>` is unreliable across Node versions, so this
 * collects the Argon unit test files explicitly and hands them to the built-in
 * runner. Keeps `npm test` working on Linux, macOS, and Windows alike.
 */
import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import process from "node:process";

const files = globSync("tests/**/*.test.{mjs,js,cjs}").sort();

if (files.length === 0) {
  console.error("No unit test files found under tests/.");
  process.exit(1);
}

console.log(`Running ${files.length} unit test file(s):\n  ${files.join("\n  ")}\n`);

const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
