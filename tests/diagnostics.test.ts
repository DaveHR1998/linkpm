import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { runSecurityAudit } from '../src/diagnostics/audit.js';
import { LOCKFILE_NAME } from '../src/lockfile/index.js';

function writeLockfile(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const lockfile = {
    lockfileVersion: 2,
    packages: {
      'my-lib@4.17.21': {
        version: '4.17.21',
        resolved: 'https://registry.example.com/my-lib/-/my-lib-4.17.21.tgz',
        isDev: false
      },
      'other-pkg@3.0.0': {
        version: '3.0.0',
        resolved: 'https://registry.example.com/other-pkg/-/other-pkg-3.0.0.tgz',
        isDev: false
      }
    }
  };
  fs.writeFileSync(path.join(dir, LOCKFILE_NAME), JSON.stringify(lockfile));
}

/** Starts a mock registry with the npm bulk advisory endpoint. */
function startMockAdvisoryServer(options: { authorize?: boolean } = {}) {
  const requests: { body: string; authHeader?: string }[] = [];

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url?.includes('/-/npm/v1/security/advisories/bulk')) {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        requests.push({ body, authHeader: req.headers.authorization });
        const payload = JSON.parse(body) as Record<string, string[]>;
        const out: Record<string, any[]> = {};
        for (const name of Object.keys(payload)) {
          if (name === 'my-lib') {
            out[name] = [
              {
                id: 1,
                title: 'Prototype pollution in my-lib (mock)',
                severity: 'critical',
                url: 'https://github.com/advisories/GHSA-mock',
                vulnerable_versions: '<4.17.22'
              }
            ];
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  return new Promise<{ url: string; requests: typeof requests; close: () => Promise<void> }>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise<void>(r => server.close(() => r()))
      });
    });
  });
}

test('runSecurityAudit queries the npm bulk advisory endpoint and matches vulnerable versions', async () => {
  const mock = await startMockAdvisoryServer();
  const tmpProject = path.join(os.tmpdir(), `linkpm-audit-test-${Date.now()}`);
  try {
    writeLockfile(tmpProject);

    const result = await runSecurityAudit(tmpProject, { registry: mock.url });

    assert.equal(result.totalScanned, 2);
    // my-lib@4.17.21 matches "<4.17.22" -> flagged critical
    const flagged = result.vulnerabilities.filter(v => v.package === 'my-lib');
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].severity, 'critical');
    assert.ok(flagged[0].url?.includes('advisories'));
    // other-pkg remains clean
    assert.equal(result.vulnerabilities.filter(v => v.package === 'other-pkg').length, 0);
    // Verify the request body contained package -> versions map
    assert.equal(mock.requests.length, 1);
    const body = JSON.parse(mock.requests[0].body);
    assert.deepEqual(body['my-lib'], ['4.17.21']);
    assert.deepEqual(body['other-pkg'], ['3.0.0']);
  } finally {
    await mock.close();
    fs.rmSync(tmpProject, { recursive: true, force: true });
  }
});

test('runSecurityAudit returns zero vulnerabilities when no advisory matches installed versions', async () => {
  const mock = await startMockAdvisoryServer();
  const tmpProject = path.join(os.tmpdir(), `linkpm-audit-clean-${Date.now()}`);
  try {
    fs.mkdirSync(tmpProject, { recursive: true });
    const lockfile = {
      lockfileVersion: 2,
      packages: {
        'my-lib@4.17.22': { version: '4.17.22', resolved: 'x', isDev: false }
      }
    };
    fs.writeFileSync(path.join(tmpProject, LOCKFILE_NAME), JSON.stringify(lockfile));

    const result = await runSecurityAudit(tmpProject, { registry: mock.url });
    assert.equal(result.totalScanned, 1);
    assert.equal(result.vulnerabilities.length, 0);
  } finally {
    await mock.close();
    fs.rmSync(tmpProject, { recursive: true, force: true });
  }
});

test('runSecurityAudit throws a clear error without a lockfile', async () => {
  const tmpProject = path.join(os.tmpdir(), `linkpm-audit-nolock-${Date.now()}`);
  fs.mkdirSync(tmpProject, { recursive: true });
  await assert.rejects(
    () => runSecurityAudit(tmpProject),
    (err: any) => err.code === 'ERR_LOCKFILE_MISMATCH'
  );
  fs.rmSync(tmpProject, { recursive: true, force: true });
});
