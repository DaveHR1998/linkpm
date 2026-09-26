import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { InstallTransaction } from '../src/linker/transaction.js';

test('InstallTransaction stages and commits links atomically', async () => {
  const tmpProject = path.join(os.tmpdir(), `linkpm-tx-test-${Date.now()}`);
  const fakeStoreDir = path.join(os.tmpdir(), `linkpm-fake-store-${Date.now()}`);

  fs.mkdirSync(tmpProject, { recursive: true });
  fs.writeFileSync(path.join(tmpProject, 'package.json'), JSON.stringify({ name: 'my-app' }));

  fs.mkdirSync(fakeStoreDir, { recursive: true });
  fs.writeFileSync(path.join(fakeStoreDir, 'package.json'), JSON.stringify({
    name: 'test-dep',
    version: '1.0.0',
    bin: { 'test-bin': 'bin.js' }
  }));
  fs.writeFileSync(path.join(fakeStoreDir, 'bin.js'), '#!/usr/bin/env node\nconsole.log(1);');

  const tx = new InstallTransaction(tmpProject);
  tx.stage('test-dep', fakeStoreDir);

  const res = await tx.commit();
  assert.equal(res.linkedCount, 1);

  const linkedPkg = path.join(tmpProject, 'node_modules', 'test-dep');
  assert.ok(fs.existsSync(linkedPkg));

  // Clean up
  fs.rmSync(tmpProject, { recursive: true, force: true });
  fs.rmSync(fakeStoreDir, { recursive: true, force: true });
});

test('InstallTransaction rollbacks unlinked packages on failure', async () => {
  const tmpProject = path.join(os.tmpdir(), `linkpm-tx-rollback-${Date.now()}`);
  fs.mkdirSync(tmpProject, { recursive: true });

  const tx = new InstallTransaction(tmpProject);
  // Staging an invalid directory should cause commit to fail and trigger rollback
  tx.stage('broken-dep', 'C:\\non-existent-directory-linkpm-test-12345');

  await assert.rejects(
    async () => {
      await tx.commit();
    },
    (err: any) => {
      assert.ok(err.message.includes('Installation transaction failed'));
      return true;
    }
  );

  fs.rmSync(tmpProject, { recursive: true, force: true });
});
