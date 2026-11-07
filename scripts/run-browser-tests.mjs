// SPDX-License-Identifier: MIT
/**
 * Browser chrome test launcher.
 *
 * Picks the project's browser-test virtualenv when it exists so `npm run
 * test:browser` does not fail with a bare ImportError on a clean machine, and
 * explains exactly how to create it when the dependency is missing.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const diagnose = process.argv.includes("--diagnose");
const script = path.join("tests", "browser", diagnose ? "diagnose.py" : "test_chrome.py");

const candidates = [
  path.join(".cache", "browser-venv", "bin", "python"),
];

let python = candidates.find((candidate) => existsSync(candidate)) ?? "python3";

const probe = spawnSync(python, ["-c", "import marionette_driver"], { stdio: "ignore" });

if (probe.status !== 0) {
  python = "python3";
  const fallback = spawnSync(python, ["-c", "import marionette_driver"], { stdio: "ignore" });
  if (fallback.status !== 0) {
    console.error(
      [
        "marionette-driver is not available to this Python interpreter.",
        "",
        "Create the isolated test environment first:",
        "  python3 -m venv .cache/browser-venv",
        "  .cache/browser-venv/bin/python -m pip install -r tests/browser/requirements.txt",
        "",
        "Then re-run: npm run test:browser",
      ].join("\n"),
    );
    process.exit(1);
  }
}

const result = spawnSync(python, [script, ...process.argv.slice(2).filter((a) => a !== "--diagnose")], {
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
