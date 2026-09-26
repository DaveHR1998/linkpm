import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runSecurityAudit } from '../src/diagnostics/audit.js';
import { LOCKFILE_NAME } from '../src/lockfile/index.js';

test('runSecurityAudit scans locked packages and flags known vulnerabilities', async () => {
  const tmpProject = path.join(os.tmpdir(), `linkpm-audit-test-${Date.now()}`);
  fs.mkdirSync(tmpProject, { recursive: true });

  const fakeLockfile = {
    lockfileVersion: 2,
    packages: {
      'lodash@4.17.21': {
        version: '4.17.21',
        tarballUrl: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
        isDev: false
      },
      'event-stream@3.3.6': {
        version: '3.3.6',
        tarballUrl: 'https://registry.npmjs.org/event-stream/-/event-stream-3.3.6.tgz',
        isDev: false
      }
    }
  };

  fs.writeFileSync(path.join(tmpProject, LOCKFILE_NAME), JSON.stringify(fakeLockfile));

  const result = await runSecurityAudit(tmpProject);
  assert.equal(result.totalScanned, 2);
  assert.equal(result.vulnerabilities.length, 1);
  assert.equal(result.vulnerabilities[0].package, 'event-stream');
  assert.equal(result.vulnerabilities[0].severity, 'critical');

  fs.rmSync(tmpProject, { recursive: true, force: true });
});
