import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import * as tar from 'tar';

import { resolvePackage, matchVersionWithCooldown, _resetRegistryClients } from '../src/registry.js';
import { installPackages, installProjectDependencies, installFromLockfile } from '../src/installer.js';
import { readLockfile, LOCKFILE_NAME, verifyLockfileIntegrity } from '../src/lockfile/index.js';
import { readPackageJson, specForWriteback } from '../src/package-json.js';
import { createUnifiedDiff, applyPatchToDirectory, isBinaryBuffer } from '../src/patches/index.js';
import { LinkPMError } from '../src/utils/errors.js';

// Unique suffix so test package names never collide with real caches
const RUN = `lp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function tmpdir(tag: string): string {
  const dir = path.join(os.tmpdir(), `linkpm-pr-${RUN}-${tag}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(...dirs: string[]) {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
}

/* ------------------------------------------------------------------ */
/* Mock npm registry                                                    */
/* ------------------------------------------------------------------ */

interface MockPkg {
  name: string;
  versions: Record<string, { tarball: Buffer; extraMeta?: Record<string, any> }>;
  publishTimes?: Record<string, string>;
}

async function startMockRegistry(packages: MockPkg[]) {
  const authLog: Array<string | undefined> = [];

  const tgzByPath = new Map<string, Buffer>();
  for (const pkg of packages) {
    for (const [version, v] of Object.entries(pkg.versions)) {
      tgzByPath.set(`/${pkg.name}/-/${pkg.name.split('/').pop()}-${version}.tgz`, v.tarball);
    }
  }

  const server = http.createServer((req, res) => {
    authLog.push(req.headers.authorization);

    if (req.method === 'GET' && req.url) {
      const urlPath = decodeURIComponent(req.url);

      if (tgzByPath.has(urlPath)) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(tgzByPath.get(urlPath));
        return;
      }

      // metadata request: /pkg or /@scope%2fpkg style
      const reqName = urlPath.replace(/^\//, '').startsWith('@')
        ? `@${urlPath.replace(/^\//, '').slice(1).replace('%2F', '/')}`
        : urlPath.replace(/^\//, '');
      const pkgName = reqName.replace('%2f', '/');
      const pkg = packages.find(p => p.name === pkgName);
      if (pkg) {
        const manifest: any = {
          name: pkg.name,
          'dist-tags': { latest: Object.keys(pkg.versions).sort().pop() },
          versions: {},
          time: {}
        };
        const base = `http://127.0.0.1:${(server.address() as any).port}`;
        for (const [version, v] of Object.entries(pkg.versions)) {
          manifest.versions[version] = {
            name: pkg.name,
            version,
            dist: {
              tarball: `${base}/${pkg.name}/-/${pkg.name.split('/').pop()}-${version}.tgz`,
              integrity: `sha512-${crypto.createHash('sha512').update(v.tarball).digest('base64')}`
            },
            ...(v.extraMeta || {})
          };
          manifest.time[version] = pkg.publishTimes?.[version] || new Date(Date.now() - 30 * 86400000).toISOString();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(manifest));
        return;
      }
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    authLog,
    close: () => new Promise<void>(r => server.close(() => r()))
  };
}

/** Stages a package dir into a gzip tarball with the npm-conventional package/ prefix. */
async function makePackageTarball(stagingFiles: Record<string, string | Buffer>, outPath: string) {
  const staging = path.join(path.dirname(outPath), `staging-${path.basename(outPath, '.tgz')}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const [rel, content] of Object.entries(stagingFiles)) {
    const full = path.join(staging, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content as any);
  }
  await tar.c({ gzip: true, file: outPath, cwd: staging, prefix: 'package' }, ['.']);
  return fs.readFileSync(outPath);
}

function writeNpmrc(projectRoot: string, registryUrl: string, port: number, extra: string = '') {
  fs.writeFileSync(
    path.join(projectRoot, '.npmrc'),
    [
      `registry=${registryUrl}/`,
      `minimum-release-age=86400`,
      `//127.0.0.1:${port}/:_authToken=test-token-abc`,
      extra
    ].filter(Boolean).join('\n') + '\n'
  );
}

/* ------------------------------------------------------------------ */
/* 1. Registry config honored on the install path                       */
/* ------------------------------------------------------------------ */

describe('Deterministic & Secure Resolution (production fixes)', () => {
  before(() => {
    _resetRegistryClients();
  });

  it('resolvePackage honors .npmrc registry, auth token, and release-age cooldown', async () => {
    const root = tmpdir('registry');
    const pkgName = `scopefree-${RUN}`;
    const tgz100 = await makePackageTarball({ 'index.js': 'module.exports = 1;', 'package.json': JSON.stringify({ name: pkgName, version: '1.0.0' }) }, path.join(root, 'p100.tgz'));
    const tgz150 = await makePackageTarball({ 'index.js': 'module.exports = 2;', 'package.json': JSON.stringify({ name: pkgName, version: '1.5.0' }) }, path.join(root, 'p150.tgz'));

    const server = await startMockRegistry([
      {
        name: pkgName,
        versions: { '1.0.0': { tarball: tgz100 }, '1.5.0': { tarball: tgz150 } },
        publishTimes: {
          '1.0.0': new Date(Date.now() - 14 * 86400000).toISOString(),      // 14d old (safe)
          '1.5.0': new Date(Date.now() - 3600000).toISOString()              // 1h old (cooldown!)
        }
      }
    ]);

    const projectRoot = path.join(root, 'proj');
    fs.mkdirSync(projectRoot, { recursive: true });
    writeNpmrc(projectRoot, server.url, server.port);

    try {
      // Cooldown on: newest (1.5.0) was published < 24h ago -> resolves to 1.0.0
      const resolvedSafe = await resolvePackage(`${pkgName}@^1.0.0`, { projectRoot });
      assert.equal(resolvedSafe.version, '1.0.0');
      assert.ok(resolvedSafe.tarballUrl.startsWith('http://127.0.0.1:'), 'must use custom registry, not registry.npmjs.org');

      // Cooldown explicitly bypassed -> resolves latest
      const resolvedFresh = await resolvePackage(`${pkgName}@^1.0.0`, { projectRoot, ignoreReleaseAge: true });
      assert.equal(resolvedFresh.version, '1.5.0');

      // Auth tokens must be sent to the configured registry
      assert.ok(server.authLog.some(a => a === 'Bearer test-token-abc'), 'Authorization header must reach the registry');
    } finally {
      await server.close();
      cleanup(root);
    }
  });

  it('cooldown enforcement errors clearly when the only satisfying version is too fresh', () => {
    const manifest: any = {
      name: 'demo',
      'dist-tags': { latest: '2.0.0' },
      versions: { '2.0.0': { name: 'demo', version: '2.0.0', dist: { tarball: 'http://x/x.tgz' } } },
      time: { '2.0.0': new Date().toISOString() }
    };
    assert.throws(
      () => matchVersionWithCooldown('demo', '^2.0.0', manifest, { minimumReleaseAgeSec: 86400 }),
      (err: any) => err instanceof LinkPMError && err.message.includes('Security Cooldown')
    );
    // ...unless excluded or bypassed
    assert.equal(matchVersionWithCooldown('demo', '^2.0.0', manifest, { minimumReleaseAgeSec: 86400, releaseAgeExclude: ['demo'] }), '2.0.0');
    assert.equal(matchVersionWithCooldown('demo', '^2.0.0', manifest, { minimumReleaseAgeSec: 86400, ignoreReleaseAge: true }), '2.0.0');
  });

  it('regression: @latest falls back to the newest cooldown-safe release instead of erroring', async () => {
    // Mirrors the lucide-react failure: newest release published < 24h ago,
    // a previous release is older than the cooldown window.
    const oldRelease = new Date(Date.now() - 7 * 86400000).toISOString();
    const manifest: any = {
      name: 'demo',
      'dist-tags': { latest: '1.50.0', beta: '1.51.0-beta.1' },
      versions: {
        '1.49.2': { name: 'demo', version: '1.49.2', dist: { tarball: 'http://x/x.tgz' } },
        '1.50.0': { name: 'demo', version: '1.50.0', dist: { tarball: 'http://x/x.tgz' } },
        '1.51.0-beta.1': { name: 'demo', version: '1.51.0-beta.1', dist: { tarball: 'http://x/x.tgz' } }
      },
      time: {
        '1.49.2': oldRelease,
        '1.50.0': new Date(Date.now() - 3600000).toISOString(),   // 1h old -> blocked
        '1.51.0-beta.1': oldRelease                                // prerelease published a week ago
      }
    };

    // Tag @latest blocked -> falls back to 1.49.2 (no throw!)
    assert.equal(matchVersionWithCooldown('demo', 'latest', manifest, { minimumReleaseAgeSec: 86400 }), '1.49.2');
    // Bare range '*' behaves the same
    assert.equal(matchVersionWithCooldown('demo', '*', manifest, { minimumReleaseAgeSec: 86400 }), '1.49.2');
    // A caret range touching the fresh release falls back too
    assert.equal(matchVersionWithCooldown('demo', '^1.45.0', manifest, { minimumReleaseAgeSec: 86400 }), '1.49.2');
    // Exact pin of the fresh version still hard-errors (security intent)
    assert.throws(
      () => matchVersionWithCooldown('demo', '1.50.0', manifest, { minimumReleaseAgeSec: 86400 }),
      (err: any) => err instanceof LinkPMError && err.message.includes('Security Cooldown')
    );
  });

  it('integration: resolvePackage("name@latest") resolves the cooldown-safe version via a mock registry', async () => {
    const root = tmpdir('tagfallback');
    const pkgName = `tagfb-${RUN}`;
    const oldTgz = await makePackageTarball({ 'index.js': 'x', 'package.json': JSON.stringify({ name: pkgName, version: '1.49.2' }) }, path.join(root, 'old.tgz'));
    const freshTgz = await makePackageTarball({ 'index.js': 'x', 'package.json': JSON.stringify({ name: pkgName, version: '1.50.0' }) }, path.join(root, 'fresh.tgz'));
    const server = await startMockRegistry([{
      name: pkgName,
      versions: { '1.49.2': { tarball: oldTgz }, '1.50.0': { tarball: freshTgz } },
      publishTimes: {
        '1.49.2': new Date(Date.now() - 7 * 86400000).toISOString(),
        '1.50.0': new Date().toISOString()
      }
    }]);

    const projectRoot = path.join(root, 'proj');
    fs.mkdirSync(projectRoot, { recursive: true });
    writeNpmrc(projectRoot, server.url, server.port);

    try {
      const resolved = await resolvePackage(`${pkgName}@latest`, { projectRoot, useLockfile: false });
      assert.equal(resolved.version, '1.49.2', 'must fall back to the newest cooldown-safe release');
    } finally {
      await server.close();
      cleanup(root);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. package.json spec preservation                                    */
/* ------------------------------------------------------------------ */

describe('package.json write-back safety (production fix)', () => {
  it('specForWriteback preserves exotic specs verbatim and uses ^ for plain registry adds', () => {
    assert.equal(specForWriteback('lib@workspace:*', '1.2.3'), 'workspace:*');
    assert.equal(specForWriteback('@scope/lib@file:../libs/tokens', '1.0.0'), 'file:../libs/tokens');
    assert.equal(specForWriteback('tokens@link:../tokens', '1.0.0'), 'link:../tokens');
    assert.equal(specForWriteback('lib@git+https://github.com/o/r.git', '1.0.0'), 'git+https://github.com/o/r.git');
    assert.equal(specForWriteback('lib@catalog:react18', '18.2.0'), 'catalog:react18');
    assert.equal(specForWriteback('my-react@npm:react@^18.2.0', '18.3.1'), 'npm:react@^18.2.0');
    assert.equal(specForWriteback('lib@https://x.y/lib.tgz', '1.0.0'), 'https://x.y/lib.tgz');
    // plain registry specs -> npm-style save prefix
    assert.equal(specForWriteback('lib', '4.17.21'), '^4.17.21');
    assert.equal(specForWriteback('lib@~4.17.0', '4.17.21'), '^4.17.21');
    assert.equal(specForWriteback('@scope/lib@2.0.0', '2.0.0'), '^2.0.0');
  });

  it('linkpm install does NOT rewrite declared version ranges in package.json', async () => {
    const root = tmpdir('norewrite');
    const pkgName = `coolpkg-${RUN}`;
    const tgz = await makePackageTarball({ 'index.js': 'module.exports = 1;', 'package.json': JSON.stringify({ name: pkgName, version: '2.0.9' }) }, path.join(root, 'c.tgz'));
    const server = await startMockRegistry([{ name: pkgName, versions: { '2.0.9': { tarball: tgz } } }]);

    const projectRoot = path.join(root, 'proj');
    fs.mkdirSync(projectRoot, { recursive: true });
    const pkgJson = { name: 'test-proj', version: '1.0.0', dependencies: { [pkgName]: '~2.0.0' } };
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify(pkgJson, null, 2));
    writeNpmrc(projectRoot, server.url, server.port);
    process.env.LINKPM_STORE_DIR = path.join(root, 'store');

    const before = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8');
    try {
      await installProjectDependencies(projectRoot, { ignoreReleaseAge: true });
      const afterPkg = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8');
      assert.equal(afterPkg, before, 'install must not rewrite package.json');

      const lock = readLockfile(projectRoot);
      assert.ok(lock && lock.packages[`${pkgName}@2.0.9`], 'lockfile must record the resolved version');
      assert.ok(lock.packages[`${pkgName}@2.0.9`].integrity, 'lockfile must record integrity');
    } finally {
      await server.close();
      cleanup(root);
      delete process.env.LINKPM_STORE_DIR;
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. Exotic transitive gating + full lockfile + read-only ci           */
/* ------------------------------------------------------------------ */

describe('Supply-chain transitive gating & pinned install (production fixes)', () => {
  let prevStoreDir: string | undefined;

  before(() => {
    prevStoreDir = process.env.LINKPM_STORE_DIR;
  });
  after(() => {
    if (prevStoreDir === undefined) delete process.env.LINKPM_STORE_DIR;
    else process.env.LINKPM_STORE_DIR = prevStoreDir;
  });

  it('blocks exotic transitive deps by default, allows with flag, pins full graph, ci is read-only', async () => {
    const root = tmpdir('gated');
    const vendored = path.join(root, 'vendored-child');
    fs.mkdirSync(vendored, { recursive: true });
    fs.writeFileSync(path.join(vendored, 'package.json'), JSON.stringify({ name: 'bad-child', version: '1.0.0' }));
    fs.writeFileSync(path.join(vendored, 'index.js'), 'module.exports = "local";');

    const parentName = `gated-parent-${RUN}`;
    const parentManifest = {
      name: parentName,
      version: '1.0.0',
      main: 'index.js',
      dependencies: { 'bad-child': 'file:../vendored-child' }
    };
    const parentTgz = await makePackageTarball(
      { 'package.json': JSON.stringify(parentManifest), 'index.js': `require('bad-child');` },
      path.join(root, 'parent.tgz')
    );

    const server = await startMockRegistry([{ name: parentName, versions: { '1.0.0': { tarball: parentTgz, extraMeta: { dependencies: parentManifest.dependencies } } } }]);

    const projectRoot = path.join(root, 'proj');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'gate-proj', version: '1.0.0', dependencies: { [parentName]: '^1.0.0' } }, null, 2));
    writeNpmrc(projectRoot, server.url, server.port);
    process.env.LINKPM_STORE_DIR = path.join(root, 'store');

    try {
      // (a) Default: transitive file: dep is blocked as a supply-chain risk
      await assert.rejects(
        () => installPackages([`${parentName}@1.0.0`], projectRoot, { ignoreReleaseAge: true, writeToPackageJson: false }),
        (err: any) => err.code === 'ERR_STORE_CORRUPTION' && err.message.includes('Transitive exotic')
      );

      // (b) Opt-in flag permits it
      const results = await installPackages([`${parentName}@1.0.0`], projectRoot, {
        ignoreReleaseAge: true,
        allowExoticTransitive: true,
        writeToPackageJson: true
      });
      assert.equal(results.length, 1);
      assert.ok(fs.existsSync(path.join(projectRoot, 'node_modules', parentName)), 'parent must be linked');

      // (c) Lockfile must pin the FULL graph including transitives
      const lock = readLockfile(projectRoot);
      assert.ok(lock, 'lockfile written');
      assert.ok(lock!.packages[`${parentName}@1.0.0`], 'top-level pinned');
      assert.ok(lock!.packages['bad-child@1.0.0'], 'transitive pinned');
      assert.equal(lock!.packages[`${parentName}@1.0.0`].dependencies?.['bad-child'], '1.0.0', 'parent dep edges recorded as exact versions');

      // (d) Frozen integrity check passes
      assert.equal(verifyLockfileIntegrity(projectRoot).valid, true);

      // (e) ci is read-only: neither package.json nor lockfile are mutated
      const pkgBefore = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8');
      const lockBefore = fs.readFileSync(path.join(projectRoot, LOCKFILE_NAME), 'utf-8');
      fs.rmSync(path.join(projectRoot, 'node_modules'), { recursive: true, force: true });

      await installFromLockfile(projectRoot, { frozenLockfile: true });

      assert.equal(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'), pkgBefore, 'ci must not rewrite package.json');
      assert.equal(fs.readFileSync(path.join(projectRoot, LOCKFILE_NAME), 'utf-8'), lockBefore, 'ci must not rewrite the lockfile');
      assert.ok(fs.existsSync(path.join(projectRoot, 'node_modules', parentName)), 'ci relinks from the store');

      // package.json declares parent with ^ — add flow normalized it; still valid semver range
      const pkgNow = readPackageJson(projectRoot);
      assert.ok(String(pkgNow.dependencies?.[parentName]).startsWith('^'));
    } finally {
      await server.close();
      cleanup(root);
    }
  });

  it('npm: alias installs link under the alias name', async () => {
    const root = tmpdir('alias');
    const realName = `alias-real-${RUN}`;
    const tgz = await makePackageTarball({ 'package.json': JSON.stringify({ name: realName, version: '3.1.0' }), 'index.js': 'module.exports = 1;' }, path.join(root, 'a.tgz'));
    const server = await startMockRegistry([{ name: realName, versions: { '3.1.0': { tarball: tgz } } }]);

    const projectRoot = path.join(root, 'proj');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'alias-proj', version: '1.0.0' }, null, 2));
    writeNpmrc(projectRoot, server.url, server.port);
    process.env.LINKPM_STORE_DIR = path.join(root, 'store');

    try {
      await installPackages([`aliasy@npm:${realName}@^3.0.0`], projectRoot, { ignoreReleaseAge: true });
      assert.ok(fs.existsSync(path.join(projectRoot, 'node_modules', 'aliasy')), 'linked under alias name');
      const pkg = readPackageJson(projectRoot);
      assert.equal(pkg.dependencies?.['aliasy'], `npm:${realName}@^3.0.0`, 'alias spec preserved verbatim');
      const lock = readLockfile(projectRoot);
      assert.ok(lock?.packages[`aliasy@3.1.0`], 'lockfile keyed by alias name');
    } finally {
      await server.close();
      cleanup(root);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 4. Patch engine: binary safety + context verification                */
/* ------------------------------------------------------------------ */

describe('Patch engine correctness (production fix)', () => {
  it('detects binary buffers', () => {
    assert.equal(isBinaryBuffer(Buffer.from('plain text, no nulls')), false);
    assert.equal(isBinaryBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d])), true);
  });

  it('round-trips text + binary patches byte-identically', () => {
    const root = tmpdir('patch');
    const origDir = path.join(root, 'orig');
    const modDir = path.join(root, 'mod');
    fs.mkdirSync(origDir, { recursive: true });
    fs.mkdirSync(modDir, { recursive: true });

    const binOrig = Buffer.from([0x00, 0x01, 0x02, 0x5a, 0xa5, 0x00, 0xff, 0xfe]);
    const binMod = Buffer.from([0x00, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x00, 0x42]);
    const txtOrig = 'line one\nline two\nline three\n';
    const txtMod = 'line one\nline two FIXED\nline three\nline four\n';

    for (const dir of [origDir, modDir]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(origDir, 'asset.bin'), binOrig);
    fs.writeFileSync(path.join(modDir, 'asset.bin'), binMod);
    fs.writeFileSync(path.join(origDir, 'index.js'), txtOrig);
    fs.writeFileSync(path.join(modDir, 'index.js'), txtMod);
    fs.writeFileSync(path.join(modDir, 'added.bin'), Buffer.from([0x50, 0x4b, 0x00, 0x00, 0x99]));

    const patch = createUnifiedDiff(origDir, modDir);
    assert.ok(patch.includes('diff --git a/index.js'), 'text file diff present');
    assert.ok(patch.includes('binary linkpm-base64'), 'binary payload emitted');

    // Apply onto a copy of the original
    const applyDir = path.join(root, 'apply');
    fs.cpSync(origDir, applyDir, { recursive: true });
    applyPatchToDirectory(applyDir, patch);

    assert.equal(fs.readFileSync(path.join(applyDir, 'index.js'), 'utf-8'), txtMod);
    assert.ok(fs.readFileSync(path.join(applyDir, 'asset.bin')).equals(binMod), 'binary patched byte-identically');
    assert.ok(fs.readFileSync(path.join(applyDir, 'added.bin')).equals(Buffer.from([0x50, 0x4b, 0x00, 0x00, 0x99])), 'added binary file byte-identical');

    cleanup(root);
  });

  it('rejects patches whose context does not match the target file', () => {
    const root = tmpdir('patchctx');
    const origDir = path.join(root, 'orig');
    fs.mkdirSync(origDir, { recursive: true });
    fs.writeFileSync(path.join(origDir, 'file.txt'), 'alpha\nbeta\ngamma\n');

    const bogusPatch = [
      'diff --git a/file.txt b/file.txt',
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1,3 +1,3 @@',
      ' WRONG CONTEXT',
      '-beta',
      '+beta modified',
      ' gamma'
    ].join('\n');

    assert.throws(
      () => applyPatchToDirectory(origDir, bogusPatch),
      (err: any) => err instanceof LinkPMError && err.message.includes('context mismatch')
    );
    // File must remain untouched on failure (mismatch aborts before write)
    assert.equal(fs.readFileSync(path.join(origDir, 'file.txt'), 'utf-8'), 'alpha\nbeta\ngamma\n');
    cleanup(root);
  });
});
