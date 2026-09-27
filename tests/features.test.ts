import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parsePnpmWorkspaceContent, resolveCatalogDependency } from '../src/workspaces/config.js';
import { getStoreDir, setStoreDir, LINKPM_HOME } from '../src/config/index.js';
import { getProjectOverrides, getOnlyBuiltDependencies, getPatchedDependencies } from '../src/package-json.js';
import { verifyLockfileIntegrity } from '../src/lockfile/index.js';
import { pruneExtraneousDependencies } from '../src/installer.js';
import { createUnifiedDiff, applyPatchToDirectory } from '../src/patches/index.js';
import { runLifecycleScripts } from '../src/store/index.js';

test('Feature 1: onlyBuiltDependencies gates supply-chain scripts', () => {
  const tmpDir = path.join(os.tmpdir(), `linkpm-sec-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const traceFile = path.join(tmpDir, 'trace.txt');
  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({
      name: 'untrusted-package',
      scripts: {
        postinstall: `node -e "require('fs').writeFileSync('trace.txt', 'ran')"`
      }
    })
  );

  // 1. Should be blocked if not in onlyBuiltDependencies
  runLifecycleScripts(tmpDir, { onlyBuiltDependencies: ['esbuild', 'sharp'] });
  assert.equal(fs.existsSync(traceFile), false, 'Untrusted postinstall script should be blocked');

  // 2. Should run if explicitly whitelisted
  runLifecycleScripts(tmpDir, { onlyBuiltDependencies: ['untrusted-package'] });
  assert.equal(fs.existsSync(traceFile), true, 'Whitelisted postinstall script should execute');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Feature 2: getProjectOverrides extracts overrides and resolutions', () => {
  const tmpDir = path.join(os.tmpdir(), `linkpm-ovr-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({
      name: 'test-app',
      resolutions: { lodash: '^4.17.21' },
      pnpm: { overrides: { axios: '^1.7.0' } }
    })
  );

  const overrides = getProjectOverrides(tmpDir);
  assert.equal(overrides['lodash'], '^4.17.21');
  assert.equal(overrides['axios'], '^1.7.0');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Feature 4: verifyLockfileIntegrity detects out-of-sync lockfile in CI mode', () => {
  const tmpDir = path.join(os.tmpdir(), `linkpm-frozen-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  // package.json requires react ^19.0.0
  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({
      name: 'app',
      dependencies: { react: '^19.0.0' }
    })
  );

  // lockfile only has react 18.2.0 (mismatch)
  fs.writeFileSync(
    path.join(tmpDir, 'linkpm-lock.json'),
    JSON.stringify({
      lockfileVersion: 2,
      packages: {
        'react@18.2.0': { version: '18.2.0', resolved: '' }
      }
    })
  );

  const res = verifyLockfileIntegrity(tmpDir);
  assert.equal(res.valid, false);
  assert.ok(res.errors.length > 0);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Feature 5: pruneExtraneousDependencies cleans up unlisted node_modules', () => {
  const tmpDir = path.join(os.tmpdir(), `linkpm-prune-test-${Date.now()}`);
  const nmDir = path.join(tmpDir, 'node_modules');
  fs.mkdirSync(path.join(nmDir, 'wanted-pkg'), { recursive: true });
  fs.mkdirSync(path.join(nmDir, 'orphan-pkg'), { recursive: true });

  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({
      name: 'app',
      dependencies: { 'wanted-pkg': '^1.0.0' }
    })
  );

  const pruned = pruneExtraneousDependencies(tmpDir);
  assert.ok(pruned.includes('orphan-pkg'));
  assert.equal(fs.existsSync(path.join(nmDir, 'orphan-pkg')), false);
  assert.equal(fs.existsSync(path.join(nmDir, 'wanted-pkg')), true);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Feature 6: parsePnpmWorkspaceContent parses default and named catalogs', () => {
  const yamlContent = `
packages:
  - 'packages/*'
catalog:
  react: ^19.0.0
  react-dom: ^19.0.0
catalogs:
  legacy:
    react: ^18.2.0
`;

  const parsed = parsePnpmWorkspaceContent(yamlContent);
  assert.deepEqual(parsed.globs, ['packages/*']);
  assert.equal(parsed.catalogs['default']['react'], '^19.0.0');
  assert.equal(parsed.catalogs['legacy']['react'], '^18.2.0');

  // Test resolution helper
  assert.equal(resolveCatalogDependency('catalog:', 'react', parsed.catalogs), '^19.0.0');
  assert.equal(resolveCatalogDependency('catalog:default', 'react-dom', parsed.catalogs), '^19.0.0');
  assert.equal(resolveCatalogDependency('catalog:legacy', 'react', parsed.catalogs), '^18.2.0');
});

test('Feature 7: createUnifiedDiff and applyPatchToDirectory work reliably', () => {
  const tmpDir = path.join(os.tmpdir(), `linkpm-diff-test-${Date.now()}`);
  const origDir = path.join(tmpDir, 'orig');
  const modDir = path.join(tmpDir, 'mod');
  const targetDir = path.join(tmpDir, 'target');

  fs.mkdirSync(origDir, { recursive: true });
  fs.mkdirSync(modDir, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });

  fs.writeFileSync(path.join(origDir, 'index.js'), 'const a = 1;\nconsole.log(a);\n');
  fs.writeFileSync(path.join(modDir, 'index.js'), 'const a = 2;\nconsole.log(a);\n');
  fs.writeFileSync(path.join(targetDir, 'index.js'), 'const a = 1;\nconsole.log(a);\n');

  const patch = createUnifiedDiff(origDir, modDir);
  assert.ok(patch.includes('-const a = 1;'));
  assert.ok(patch.includes('+const a = 2;'));

  applyPatchToDirectory(targetDir, patch);
  const updatedContent = fs.readFileSync(path.join(targetDir, 'index.js'), 'utf-8');
  assert.ok(updatedContent.includes('const a = 2;'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Feature 8: setStoreDir and getStoreDir allow configuring central store', () => {
  const initial = getStoreDir();
  const custom = path.join(os.tmpdir(), 'custom-linkpm-store');

  setStoreDir(custom);
  assert.equal(getStoreDir(), path.resolve(custom));

  // Reset back
  setStoreDir(null);
  assert.equal(getStoreDir(), initial);
});
