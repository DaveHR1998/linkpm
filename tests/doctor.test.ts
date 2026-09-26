import test from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor } from '../src/diagnostics/doctor.js';

test('runDoctor executes diagnostics without throwing', async () => {
  const checks = await runDoctor(process.cwd());
  assert.ok(checks.length >= 4);

  const nodeCheck = checks.find(c => c.name === 'Node.js Runtime');
  assert.ok(nodeCheck);
  assert.equal(nodeCheck.status, 'pass');

  const platformCheck = checks.find(c => c.name === 'Platform & Arch');
  assert.ok(platformCheck);
  assert.equal(platformCheck.status, 'pass');
});
