#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
//
// Argon adblock policy tooling.
//
// The uBlock Origin enterprise policy is removed only through `retire`, which
// refuses while any parity gate is unmet. No other command edits the shipping
// policy. Usage:
//
//   node scripts/adblock-policy.mjs status
//   node scripts/adblock-policy.mjs fragment --sites example.com,other.test
//   node scripts/adblock-policy.mjs verify --evidence parity-evidence.json
//   node scripts/adblock-policy.mjs retire --evidence parity-evidence.json [--write]
//
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_EXTENSION_ID, PARITY_GATES, PARITY_VERSION, ParityGate, PolicyDocumentSink,
} from '../argon/adblock/policy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!flag?.startsWith('--')) throw new Error('Unexpected argument: ' + flag);
    const name = flag.slice(2);
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith('--')) { options[name] = next; index += 1; }
    else options[name] = true;
  }
  return { command, options };
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function readEvidence(path) {
  if (!path) return {};
  const document = await readJson(path, null);
  if (!document) return {};
  if (document.parityVersion !== PARITY_VERSION) throw new Error('Evidence file targets a different parity version');
  return document.evidence ?? {};
}

function gateWith(options) {
  return readEvidence(options.evidence ? resolve(ROOT, options.evidence) : null)
    .then(evidence => new ParityGate({ evidence }));
}

function reportGate(gate) {
  const missing = gate.unmet();
  console.log(`Parity gates: ${gate.gates.length - missing.length}/${gate.gates.length} met (version ${PARITY_VERSION})`);
  for (const item of gate.gates) {
    const state = gate.evidence[item.id];
    console.log(`  ${state?.status === 'met' ? 'met ' : 'UNMET'} ${item.id} — ${item.description}`);
  }
  return missing.length;
}

const commands = {
  async status({ options }) {
    const policyPath = resolve(ROOT, options.policy || 'settings/distribution/policies.json');
    const document = await readJson(policyPath, null);
    const entry = document?.policies?.ExtensionSettings?.[DEFAULT_EXTENSION_ID];
    console.log(`uBlock Origin policy: ${entry ? entry.installation_mode : 'absent'} (${policyPath})`);
    const gate = await gateWith(options);
    reportGate(gate);
    console.log('\nStatus is informational; use verify for a CI gate or retire to remove the policy.');
    return 0;
  },
  async fragment({ options }) {
    if (!options.sites) throw new Error('fragment requires --sites example.com,other.test');
    const sites = options.sites.split(',').map(site => site.trim()).filter(Boolean);
    const document = new PolicyDocumentSink().render(sites);
    console.log(JSON.stringify(document, null, 2) + '\n');
    return 0;
  },
  async verify({ options }) {
    const gate = await gateWith(options);
    const missing = reportGate(gate);
    if (missing) console.error(`\nRefusing to retire: ${missing} parity gate(s) unmet.`);
    return missing ? 1 : 0;
  },
  async retire({ options }) {
    const policyPath = resolve(ROOT, options.policy || 'settings/distribution/policies.json');
    const gate = await gateWith(options);
    reportGate(gate);
    // Throws before touching the document when any gate is unmet.
    gate.assertRetirementAllowed();
    const document = await readJson(policyPath, null);
    let next = null;
    const result = await gate.retireExtension({
      read: async () => document,
      write: async value => { next = value; },
    });
    if (!result.changed) {
      console.log(`\n${DEFAULT_EXTENSION_ID} is not present in ${policyPath}; nothing to do.`);
      return 0;
    }
    if (!options.write) {
      console.log('\nDry run. The policy would become:\n' + JSON.stringify(next, null, 2) + '\n');
      console.log('Re-run with --write to apply.');
      return 0;
    }
    await writeFile(policyPath, JSON.stringify(next, null, 2) + '\n');
    console.log(`\nRemoved ${DEFAULT_EXTENSION_ID} from ${policyPath}.`);
    return 0;
  },
};

const HELP = `Argon adblock policy tooling

Commands:
  status                                  Show the uBlock policy and parity gate status
  fragment --sites a.com,b.test           Render the ExtensionSettings coordination fragment
  verify  --evidence <file>               Exit 1 unless every parity gate is met
  retire  --evidence <file> [--write]     Remove the uBlock policy only when all gates are met

Options:
  --policy <path>                         Policy document (default settings/distribution/policies.json)
  --evidence <path>                       Parity evidence JSON (default: none, every gate unmet)
  --write                                 Apply the retirement instead of printing a dry run
`;

try {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    process.exit(command ? 0 : 1);
  }
  if (!Object.hasOwn(commands, command)) throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  process.exit(await commands[command]({ options }));
} catch (error) {
  console.error(`adblock-policy: ${error.message}`);
  process.exit(1);
}
