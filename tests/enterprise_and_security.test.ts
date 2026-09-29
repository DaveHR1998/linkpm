import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { importLockfile, readLockfile } from '../src/lockfile/index.js';
import { formatSarifReport, AuditResult } from '../src/diagnostics/audit.js';

test('Enterprise Compliance: importLockfile imports Dependabot package-lock.json and synchronizes linkpm-lock.json', () => {
  const tmpProject = path.join(os.tmpdir(), `linkpm-import-test-${Date.now()}`);
  fs.mkdirSync(tmpProject, { recursive: true });

  fs.writeFileSync(
    path.join(tmpProject, 'package.json'),
    JSON.stringify({
      name: 'enterprise-app',
      version: '1.0.0',
      dependencies: {
        axios: '^1.7.0'
      }
    })
  );

  // Simulate a package-lock.json created or updated by Dependabot
  const dependabotLock = {
    name: 'enterprise-app',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'enterprise-app',
        dependencies: {
          axios: '^1.7.0'
        }
      },
      'node_modules/axios': {
        version: '1.7.2',
        resolved: 'https://registry.npmjs.org/axios/-/axios-1.7.2.tgz',
        integrity: 'sha512-axios-sha512-hash',
        dependencies: {
          'follow-redirects': '^1.15.6'
        }
      },
      'node_modules/follow-redirects': {
        version: '1.15.6',
        resolved: 'https://registry.npmjs.org/follow-redirects/-/follow-redirects-1.15.6.tgz',
        integrity: 'sha512-follow-sha512-hash'
      }
    }
  };

  const npmLockPath = path.join(tmpProject, 'package-lock.json');
  fs.writeFileSync(npmLockPath, JSON.stringify(dependabotLock, null, 2));

  // Run importLockfile
  const res = importLockfile(tmpProject, npmLockPath);
  assert.equal(res.importedCount, 2);

  // Verify linkpm-lock.json was generated and contains the imported versions
  const linkpmLock = readLockfile(tmpProject);
  assert.ok(linkpmLock);
  assert.ok(linkpmLock.packages['axios@1.7.2']);
  assert.equal(linkpmLock.packages['axios@1.7.2'].version, '1.7.2');
  assert.equal(linkpmLock.packages['axios@1.7.2'].resolved, 'https://registry.npmjs.org/axios/-/axios-1.7.2.tgz');
  assert.equal(linkpmLock.packages['axios@1.7.2'].integrity, 'sha512-axios-sha512-hash');
  assert.ok(linkpmLock.packages['follow-redirects@1.15.6']);

  fs.rmSync(tmpProject, { recursive: true, force: true });
});

test('Enterprise Compliance: formatSarifReport outputs valid SARIF v2.1.0 for GitHub Code Scanning', () => {
  const auditResult: AuditResult = {
    totalScanned: 5,
    vulnerabilities: [
      {
        package: 'event-stream',
        version: '3.3.6',
        severity: 'critical',
        title: 'Flatmap-stream malware injection',
        url: 'https://github.com/advisories/GHSA-952p-64cx-jc55'
      },
      {
        package: 'minimist',
        version: '0.0.8',
        severity: 'low',
        title: 'Prototype pollution in minimist',
        url: 'https://github.com/advisories/GHSA-vh95-rmgr-6w4m'
      }
    ]
  };

  const sarifStr = formatSarifReport(auditResult);
  const sarif = JSON.parse(sarifStr);

  assert.equal(sarif.version, '2.1.0');
  assert.ok(sarif.runs && sarif.runs.length > 0);

  const run = sarif.runs[0];
  assert.equal(run.tool.driver.name, 'LinkPM Security Audit');
  assert.equal(run.results.length, 2);

  // Critical vulnerability must map to error level
  assert.equal(run.results[0].ruleId, 'LP-SEC-event-stream');
  assert.equal(run.results[0].level, 'error');
  assert.ok(run.results[0].message.text.includes('Flatmap-stream malware injection'));
  assert.equal(run.results[0].locations[0].physicalLocation.artifactLocation.uri, 'package.json');

  // Low vulnerability must map to note level
  assert.equal(run.results[1].ruleId, 'LP-SEC-minimist');
  assert.equal(run.results[1].level, 'note');
});
