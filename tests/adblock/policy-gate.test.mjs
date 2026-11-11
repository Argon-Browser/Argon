import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_EXTENSION_ID, PARITY_GATES, PARITY_VERSION, ParityGate,
} from '../../argon/adblock/policy.mjs';

const POLICY_URL = new URL('../../settings/distribution/policies.json', import.meta.url);

function memoryDocument() {
  return {
    policies: {
      DisableAppUpdate: true,
      ExtensionSettings: {
        '*': { installation_mode: 'allowed', allowed_types: ['dictionary', 'extension'] },
        [DEFAULT_EXTENSION_ID]: { installation_mode: 'normal_installed', private_browsing: true },
      },
    },
  };
}

test('retirement is refused while any parity gate is unmet', async () => {
  assert.ok(PARITY_GATES.length >= 8, 'the parity gate checklist must stay explicit');
  assert.equal(PARITY_VERSION, 1);
  const gate = new ParityGate();
  assert.equal(gate.unmet().length, PARITY_GATES.length);
  assert.throws(() => gate.assertRetirementAllowed(), new RegExp(PARITY_GATES[0].id));

  const document = memoryDocument();
  let written = null;
  await assert.rejects(gate.retireExtension({
    read: async () => document,
    write: async next => { written = next; },
  }), /cannot be removed yet/);
  assert.equal(written, null, 'a refused retirement must not write the policy document');
  assert.ok(document.policies.ExtensionSettings[DEFAULT_EXTENSION_ID], 'the in-memory document is untouched');
});

test('retirement proceeds only after every gate records evidence', async () => {
  const gate = new ParityGate();
  for (const item of PARITY_GATES) gate.record(item.id, 'met', 'fixture evidence');
  assert.deepEqual(gate.unmet(), []);
  assert.equal(gate.assertRetirementAllowed(), true);

  const document = memoryDocument();
  const result = await gate.retireExtension({
    read: async () => document,
    write: async next => { document.written = next; },
  });
  assert.equal(result.changed, true);
  assert.equal(document.written.policies.ExtensionSettings[DEFAULT_EXTENSION_ID], undefined,
    'the extension entry is removed');
  assert.deepEqual(document.written.policies.ExtensionSettings['*'], { installation_mode: 'allowed', allowed_types: ['dictionary', 'extension'] },
    'every unrelated policy survives the removal');
  assert.equal(document.written.policies.DisableAppUpdate, true);

  // Removing an already-absent entry is a no-op, not an error.
  const again = await gate.retireExtension({
    read: async () => document.written,
    write: async next => { document.written = next; },
  });
  assert.equal(again.changed, false);
});

test('the gate rejects unknown gates and invalid statuses', () => {
  const gate = new ParityGate();
  assert.throws(() => gate.record('not-a-gate', 'met'), /Unknown parity gate/);
  assert.throws(() => gate.record(PARITY_GATES[0].id, 'maybe'), /Invalid gate status/);
  gate.record(PARITY_GATES[0].id, 'unmet');
  assert.equal(gate.unmet().length, PARITY_GATES.length);
});

test('the shipping policy no longer installs uBlock Origin: parity is claimed and native is default', async () => {
  const document = JSON.parse(await readFile(POLICY_URL, 'utf8'));
  const settings = document.policies?.ExtensionSettings ?? {};
  assert.equal(settings[DEFAULT_EXTENSION_ID], undefined, 'uBlock Origin policy must be absent after parity retirement');
});
