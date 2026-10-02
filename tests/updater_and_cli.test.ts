import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scheduleUpdateNotice } from '../src/updater.js';
import { listInstalled } from '../src/diagnostics/list.js';
import { LOCKFILE_NAME } from '../src/lockfile/index.js';

test('updater: scheduleUpdateNotice handles missing cache and malformed versions safely without throwing', () => {
  // Should not throw under any circumstances
  assert.doesNotThrow(() => {
    scheduleUpdateNotice('1.0.0');
    scheduleUpdateNotice('invalid-version');
    scheduleUpdateNotice('');
  });
});

test('diagnostics: listInstalled extracts dependencies from lockfile and node_modules fallback', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkpm-list-test-'));

  try {
    // 1. Create mock package.json
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'test-app',
        dependencies: {
          lodash: '^4.17.21',
          uninstalled: '^1.0.0'
        },
        devDependencies: {
          typescript: '^5.0.0'
        }
      }, null, 2),
      'utf-8'
    );

    // 2. Create mock lockfile
    fs.writeFileSync(
      path.join(tmpDir, LOCKFILE_NAME),
      JSON.stringify({
        lockfileVersion: 2,
        packages: {
          'lodash@4.17.21': { version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
          'typescript@5.4.5': { version: '5.4.5', resolved: 'https://registry.npmjs.org/typescript/-/typescript-5.4.5.tgz' }
        }
      }, null, 2),
      'utf-8'
    );

    // 3. Test listing
    const result = listInstalled(tmpDir);
    assert.equal(result.dependencies.length, 2);
    assert.equal(result.devDependencies.length, 1);

    const lodash = result.dependencies.find(d => d.name === 'lodash');
    assert.ok(lodash);
    assert.equal(lodash.version, '4.17.21');
    assert.equal(lodash.from, 'lockfile');

    const uninstalled = result.dependencies.find(d => d.name === 'uninstalled');
    assert.ok(uninstalled);
    assert.equal(uninstalled.version, '(not installed)');
    assert.equal(uninstalled.from, 'unknown');

    const ts = result.devDependencies.find(d => d.name === 'typescript');
    assert.ok(ts);
    assert.equal(ts.version, '5.4.5');
    assert.equal(ts.from, 'lockfile');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
