# Argon Extension Bridge

Status: Module 1 (Manifest Analyzer) proof of concept, plus the 50-extension
benchmark registry. Modules 2-5 from the implementation plan are not built.

This document describes what exists, what it proves, and what it explicitly
does not prove.

## What the analyzer does

`argon/extensions/manifest-analyzer.mjs` performs static analysis of an
untrusted `manifest.json` and returns an English report. It:

- validates the manifest version, `name`, and `version` shape;
- inventories required and optional API permissions, keeping the declared
  boundaries without deduplicating or moving them;
- inventories host permissions and content-script match patterns, checking
  syntax without rewriting or expanding a pattern;
- flags MV3 host declarations placed in `permissions`, Chrome-specific
  permissions, unknown permissions, broad host access, native messaging, and
  API semantics that need human review;
- identifies the Manifest V3 service-worker lifecycle gap, which is the core
  technical risk described in the plan;
- records unknown manifest keys as unknown data that requires review.

## What the analyzer does not do

It does not download, unpack, import, or execute extension code. It does not
grant permissions, and it does not predict whether an extension will run. Every
report carries `scope: STATIC_MANIFEST_ONLY` and
`runtimeCompatibility: NOT_TESTED`, and the notice states that static analysis
does not establish runtime compatibility or safety.

## Untrusted input handling

A real manifest reaches the analyzer through `JSON.parse`, which cannot produce
accessors, exotic prototypes, or cycles. Because a manifest object can also
arrive from another code path, `argon/extensions/json-safety.mjs` gates the
input first:

- values are read through property descriptors, never through `value[key]`, so
  an accessor or a Proxy `get` trap never runs;
- the input is rebuilt into a fresh plain object with `defineProperty`, so a
  `__proto__` key is copied as data and cannot reach a prototype;
- getters, exotic prototypes, cycles, `BigInt`, `NaN`, `Infinity`, `undefined`,
  `Symbol`, `Date`, sparse arrays, and nesting deeper than 32 levels are
  rejected with a single `NON_JSON_INPUT` finding.

A Proxy whose handler forwards every trap is semantically identical to its
target and cannot be recognized: key enumeration necessarily goes through
`ownKeys`. The guarantee is that no extension-controlled code runs, not that
every proxy is detected.

## Command line

```bash
# Human-readable report; exit code carries the verdict.
node argon/extensions/analyze-cli.mjs path/to/manifest.json

# Machine-readable report with the same exit code.
node argon/extensions/analyze-cli.mjs path/to/manifest.json --json

# Read from standard input.
cat manifest.json | node argon/extensions/analyze-cli.mjs -
```

| Exit code | Meaning |
| :-- | :-- |
| `0` | No known static issues. Not a compatibility claim. |
| `1` | Valid manifest that requires manual review. |
| `2` | Invalid manifest. |
| `3` | Input problem: missing or unreadable file, malformed JSON, no input. |

## Benchmark registry

`argon/extensions/benchmark-registry.json` holds the 50 representative
extensions named in the implementation plan, spanning content blockers,
translators, password managers, developer tools, productivity, and appearance.

The registry is a list of **candidates**, not results:

- every entry carries `status: "NOT_TESTED"`;
- `manifestVersion` is `null` because no package has been parsed;
- `target.betaSuccessRate` is `0.8` with `target.status: "UNVERIFIED"` and
  `testedCount: 0`, because the plan's 80% figure is an engineering target, not
  a measured rate;
- `provenance.packagesDownloaded` is `0`.

Candidates were drawn from live Mozilla Add-ons search results, assigned to a
category by their stated purpose, and every listing URL was verified with an
HTTP request. Names, slugs, and URLs are therefore sourced, not invented; no
compatibility judgement has been made about any of them.

Regenerating the list is a manual step: query the AMO search API, reassign
categories by purpose, verify each listing URL, and keep every `status` at
`NOT_TESTED` until a real install and run has happened.

## Remaining work from the plan

| Module | State |
| :-- | :-- |
| 1. Manifest Analyzer | Implemented and tested (static analysis only) |
| 2. Compatibility Adapter | Not started: manifest rewriting and polyfill injection |
| 3. Background Runtime | Not started: MV3 service-worker lifecycle bridge |
| 4. Extension Installer | Not started: CRX/ZIP extraction, integrity checks, consent |
| 5. Compatibility Database | Registry scaffolded; no results collected |

Distribution constraints from the plan still apply: no one-click Chrome Web
Store installation, Mozilla add-on signing and distribution policy is
respected, and extension code must never run in a privileged parent process.

## Tests

```bash
node --test tests/extensions/*.test.mjs
```

The suite covers manifest validation, permission boundaries, match-pattern
syntax, MV3 lifecycle findings, untrusted-input rejection, CLI exit codes, and
the registry's schema and honesty constraints.
