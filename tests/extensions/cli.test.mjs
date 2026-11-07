import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname: pathname stays percent-encoded, and this
// repository lives under a path with spaces and non-ASCII characters.
const CLI = fileURLToPath(new URL("../../argon/extensions/analyze-cli.mjs", import.meta.url));

const EXIT = { CLEAN: 0, REVIEW: 1, INVALID: 2, INPUT: 3 };

function run(args, input) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    input,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function withManifest(content) {
  const dir = mkdtempSync(path.join(tmpdir(), "argon-cli-"));
  const file = path.join(dir, "manifest.json");
  writeFileSync(file, content);
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a clean manifest exits 0 and reports no known static issues", () => {
  const { file, cleanup } = withManifest(JSON.stringify({
    manifest_version: 3, name: "Clean Example", version: "1.0",
  }));
  try {
    const { code, stdout } = run([file]);
    assert.equal(code, EXIT.CLEAN);
    assert.match(stdout, /NO_KNOWN_STATIC_ISSUES/);
  } finally {
    cleanup();
  }
});

test("a manifest needing review exits 1 and prints an English finding", () => {
  const { file, cleanup } = withManifest(JSON.stringify({
    manifest_version: 3, name: "Review Example", version: "1.0",
    permissions: ["someFutureApi"],
  }));
  try {
    const { code, stdout } = run([file]);
    assert.equal(code, EXIT.REVIEW);
    assert.match(stdout, /MANUAL_REVIEW_REQUIRED/);
    assert.match(stdout, /UNKNOWN_PERMISSION/);
  } finally {
    cleanup();
  }
});

test("an invalid manifest exits 2", () => {
  const { file, cleanup } = withManifest(JSON.stringify({
    manifest_version: 3, name: "Bad Version", version: "1.2-beta",
  }));
  try {
    const { code, stdout } = run([file]);
    assert.equal(code, EXIT.INVALID);
    assert.match(stdout, /INVALID_MANIFEST/);
    assert.match(stdout, /INVALID_VERSION/);
  } finally {
    cleanup();
  }
});

test("a JSON array root exits 2 with INVALID_ROOT", () => {
  const { file, cleanup } = withManifest("[]");
  try {
    const { code, stdout } = run([file]);
    assert.equal(code, EXIT.INVALID);
    assert.match(stdout, /INVALID_ROOT/);
  } finally {
    cleanup();
  }
});

test("a missing file exits 3 without pretending the manifest is invalid", () => {
  const missing = path.join(tmpdir(), "argon-definitely-missing-manifest.json");
  const { code, stderr } = run([missing]);
  assert.equal(code, EXIT.INPUT);
  assert.match(stderr, /cannot read/i);
  assert.doesNotMatch(stderr, /INVALID_MANIFEST/);
});

test("malformed JSON exits 3", () => {
  const { file, cleanup } = withManifest("{ not json");
  try {
    const { code, stderr } = run([file]);
    assert.equal(code, EXIT.INPUT);
    assert.match(stderr, /not valid JSON/i);
  } finally {
    cleanup();
  }
});

test("--json emits machine-readable output on the same exit code", () => {
  const { file, cleanup } = withManifest(JSON.stringify({
    manifest_version: 3, name: "JSON Example", version: "1.0", permissions: ["tabs"],
  }));
  try {
    const { code, stdout } = run([file, "--json"]);
    assert.equal(code, EXIT.CLEAN);
    const report = JSON.parse(stdout);
    assert.equal(report.scope, "STATIC_MANIFEST_ONLY");
    assert.equal(report.runtimeCompatibility, "NOT_TESTED");
    assert.equal(report.valid, true);
    assert.equal(report.manifest.name, "JSON Example");
  } finally {
    cleanup();
  }
});

test("reads the manifest from stdin when the path is -", () => {
  const { code, stdout } = run(["-", "--json"], JSON.stringify({
    manifest_version: 2, name: "Stdin Example", version: "2.0",
  }));
  assert.equal(code, EXIT.CLEAN);
  assert.equal(JSON.parse(stdout).manifest.manifestVersion, 2);
});

test("usage is printed and exits 3 when no manifest is given", () => {
  const { code, stderr } = run([]);
  assert.equal(code, EXIT.INPUT);
  assert.match(stderr, /usage/i);
});

test("the analyzer never claims runtime compatibility in its output", () => {
  const { file, cleanup } = withManifest(JSON.stringify({
    manifest_version: 3, name: "Notice Example", version: "1.0",
  }));
  try {
    const { stdout } = run([file]);
    assert.match(stdout, /not tested/i);
  } finally {
    cleanup();
  }
});
