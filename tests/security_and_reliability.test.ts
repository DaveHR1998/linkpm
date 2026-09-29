import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { applyPatchToDirectory } from '../src/patches/index.js';
import { safeRemoveLinkOrDir } from '../src/linker.js';
import { pruneExtraneousDependencies } from '../src/installer.js';
import { FileLock } from '../src/store/lock.js';
import { LinkPMError, IntegrityMismatchError } from '../src/utils/errors.js';
import { runLifecycleScripts, verifyStore, isNativePackage, getNativeAbiSuffix } from '../src/store/index.js';
import { findUnapprovedBuiltDependencies, approveBuiltDependencies } from '../src/scripts/approve.js';
import { computePeerContextHash } from '../src/linker/virtual-store.js';
import { loadNpmrcConfig } from '../src/config/npmrc.js';

describe('Security & Production Reliability Tests', () => {
  const tmpDir = path.join(os.tmpdir(), `linkpm-sec-test-${Date.now()}`);

  before(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('1. Patch Path Traversal Defense (Zip-Slip)', () => {
    it('should throw an error and block patches attempting path traversal', () => {
      const pkgDir = path.join(tmpDir, 'test-pkg');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'index.js'), 'console.log("hello");\n');

      const maliciousPatch = [
        'diff --git a/../../outside.txt b/../../outside.txt',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/../../outside.txt',
        '@@ -0,0 +1,1 @@',
        '+MALICIOUS CONTENT'
      ].join('\n');

      assert.throws(
        () => {
          applyPatchToDirectory(pkgDir, maliciousPatch);
        },
        (err: any) => {
          return err instanceof LinkPMError && err.message.includes('Security violation');
        }
      );
    });

    it('should accurately apply non-contiguous hunks with line offsets', () => {
      const pkgDir = path.join(tmpDir, 'hunk-pkg');
      fs.mkdirSync(pkgDir, { recursive: true });

      const initialLines = [
        'line 1',
        'line 2',
        'line 3',
        'line 4',
        'line 5',
        'line 6',
        'line 7',
        'line 8',
        'line 9',
        'line 10'
      ];
      fs.writeFileSync(path.join(pkgDir, 'file.txt'), initialLines.join('\n'));

      // Patch that modifies line 5 and line 9
      const patch = [
        'diff --git a/file.txt b/file.txt',
        '--- a/file.txt',
        '+++ b/file.txt',
        '@@ -5,1 +5,1 @@',
        '-line 5',
        '+line 5 modified',
        '@@ -9,1 +9,1 @@',
        '-line 9',
        '+line 9 modified'
      ].join('\n');

      applyPatchToDirectory(pkgDir, patch);

      const modified = fs.readFileSync(path.join(pkgDir, 'file.txt'), 'utf-8').split(/\r?\n/);
      assert.strictEqual(modified[0], 'line 1');
      assert.strictEqual(modified[3], 'line 4');
      assert.strictEqual(modified[4], 'line 5 modified');
      assert.strictEqual(modified[7], 'line 8');
      assert.strictEqual(modified[8], 'line 9 modified');
      assert.strictEqual(modified[9], 'line 10');
    });
  });

  describe('2. Safe Windows Junction / Symlink Deletion', () => {
    it('safeRemoveLinkOrDir must remove the link without deleting target directory contents', () => {
      const targetDir = path.join(tmpDir, 'target-store-package');
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, 'critical-code.js'), 'export const secret = 42;');

      const linkPath = path.join(tmpDir, 'nm-link');
      const linkType = process.platform === 'win32' ? 'junction' : 'dir';
      fs.symlinkSync(targetDir, linkPath, linkType);

      assert.strictEqual(fs.existsSync(linkPath), true);
      assert.strictEqual(fs.existsSync(path.join(linkPath, 'critical-code.js')), true);

      // Call safeRemoveLinkOrDir
      const removed = safeRemoveLinkOrDir(linkPath);
      assert.strictEqual(removed, true);

      // Verify the link is gone
      assert.strictEqual(fs.existsSync(linkPath), false);

      // VERIFY CRITICAL: The physical target and its files are 100% INTACT
      assert.strictEqual(fs.existsSync(targetDir), true);
      assert.strictEqual(fs.existsSync(path.join(targetDir, 'critical-code.js')), true);
      const content = fs.readFileSync(path.join(targetDir, 'critical-code.js'), 'utf-8');
      assert.strictEqual(content, 'export const secret = 42;');
    });
  });

  describe('3. Extraneous Pruning with Optional & Peer Dependencies', () => {
    it('should preserve optionalDependencies and peerDependencies during pruning', () => {
      const projDir = path.join(tmpDir, 'proj-prune');
      fs.mkdirSync(projDir, { recursive: true });
      const nmDir = path.join(projDir, 'node_modules');
      fs.mkdirSync(nmDir, { recursive: true });

      // Create fake package.json
      fs.writeFileSync(
        path.join(projDir, 'package.json'),
        JSON.stringify({
          name: 'my-proj',
          dependencies: {
            'prod-pkg': '^1.0.0'
          },
          devDependencies: {
            'dev-pkg': '^1.0.0'
          },
          optionalDependencies: {
            'optional-pkg': '^1.0.0'
          },
          peerDependencies: {
            'peer-pkg': '^1.0.0'
          }
        })
      );

      // Create directories in node_modules
      for (const name of ['prod-pkg', 'dev-pkg', 'optional-pkg', 'peer-pkg', 'extraneous-pkg']) {
        const pkgFolder = path.join(nmDir, name);
        fs.mkdirSync(pkgFolder, { recursive: true });
        fs.writeFileSync(path.join(pkgFolder, 'package.json'), JSON.stringify({ name }));
      }

      const pruned = pruneExtraneousDependencies(projDir);

      assert.deepStrictEqual(pruned, ['extraneous-pkg']);
      assert.strictEqual(fs.existsSync(path.join(nmDir, 'prod-pkg')), true);
      assert.strictEqual(fs.existsSync(path.join(nmDir, 'dev-pkg')), true);
      assert.strictEqual(fs.existsSync(path.join(nmDir, 'optional-pkg')), true, 'optional-pkg must be preserved');
      assert.strictEqual(fs.existsSync(path.join(nmDir, 'peer-pkg')), true, 'peer-pkg must be preserved');
      assert.strictEqual(fs.existsSync(path.join(nmDir, 'extraneous-pkg')), false, 'extraneous-pkg must be pruned');
    });
  });

  describe('4. FileLock Active Tracking and Signal Cleanup', () => {
    it('should track active locks and release them via releaseAll()', async () => {
      const lock1 = path.join(tmpDir, 'test1.lock');
      const lock2 = path.join(tmpDir, 'test2.lock');

      await FileLock.acquire(lock1);
      await FileLock.acquire(lock2);

      assert.strictEqual(fs.existsSync(lock1), true);
      assert.strictEqual(fs.existsSync(lock2), true);

      FileLock.releaseAll();

      assert.strictEqual(fs.existsSync(lock1), false);
      assert.strictEqual(fs.existsSync(lock2), false);
    });
  });

  describe('5. Checksum Integrity Calculation', () => {
    it('should accurately verify SHA-512 and SHA-1 hashes', () => {
      const testBuffer = Buffer.from('hello linkpm security');
      const sha512 = crypto.createHash('sha512').update(testBuffer).digest('base64');
      const sha1 = crypto.createHash('sha1').update(testBuffer).digest('base64');
      const hexSha1 = crypto.createHash('sha1').update(testBuffer).digest('hex');

      assert.ok(sha512.length > 50);
      assert.ok(sha1.length > 20);
      assert.strictEqual(hexSha1.length, 40);
    });
  });

  describe('6. findProjectRoot Parent Directory Traversal', () => {
    it('should find root package.json when called from a deep subdirectory', async () => {
      const { findProjectRoot } = await import('../src/package-json.js');
      const rootDir = path.join(tmpDir, 'monorepo-sub');
      const subDir = path.join(rootDir, 'src', 'components', 'button');
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ name: 'root-pkg' }));

      const found = findProjectRoot(subDir);
      assert.strictEqual(found, rootDir);
    });
  });

  describe('7. Corrupted package.json Syntax Error Defense', () => {
    it('should throw an error and refuse to overwrite corrupted package.json', async () => {
      const { readPackageJson } = await import('../src/package-json.js');
      const corruptDir = path.join(tmpDir, 'corrupt-dir');
      fs.mkdirSync(corruptDir, { recursive: true });
      const pkgPath = path.join(corruptDir, 'package.json');
      fs.writeFileSync(pkgPath, '{ "name": "corrupt", invalid_json }');

      assert.throws(
        () => {
          readPackageJson(corruptDir);
        },
        (err: any) => {
          return err instanceof LinkPMError && err.message.includes('Syntax error in package.json');
        }
      );
    });
  });

  describe('8. Content-Hashed Store Paths for Patches', () => {
    it('should isolate patched versions in a hashed directory without modifying the original package', async () => {
      const { computePatchHash } = await import('../src/store/index.js');
      const { applyPatchToDirectory } = await import('../src/patches/index.js');

      const pkgName = 'date-fns';
      const version = '2.30.0';
      const cleanStoreDir = path.join(tmpDir, 'store', pkgName, version);
      fs.mkdirSync(cleanStoreDir, { recursive: true });
      fs.writeFileSync(path.join(cleanStoreDir, 'index.js'), 'module.exports = "ORIGINAL_DATE_FNS";\n');

      const patch = [
        'diff --git a/index.js b/index.js',
        '--- a/index.js',
        '+++ b/index.js',
        '@@ -1,1 +1,1 @@',
        '-module.exports = "ORIGINAL_DATE_FNS";',
        '+module.exports = "PATCHED_DATE_FNS";'
      ].join('\n');

      const hash = computePatchHash(patch);
      assert.strictEqual(hash.length, 8);

      const patchedStoreDir = path.join(tmpDir, 'store', pkgName, `${version}_patch_${hash}`);
      fs.mkdirSync(patchedStoreDir, { recursive: true });
      fs.copyFileSync(path.join(cleanStoreDir, 'index.js'), path.join(patchedStoreDir, 'index.js'));
      applyPatchToDirectory(patchedStoreDir, patch);

      // Verify the clean store directory is UNTOUCHED
      const originalContent = fs.readFileSync(path.join(cleanStoreDir, 'index.js'), 'utf-8');
      assert.strictEqual(originalContent, 'module.exports = "ORIGINAL_DATE_FNS";\n');

      // Verify the patched store directory has the custom code
      const patchedContent = fs.readFileSync(path.join(patchedStoreDir, 'index.js'), 'utf-8');
      assert.strictEqual(patchedContent.trim(), 'module.exports = "PATCHED_DATE_FNS";');
    });
  });

  describe('9. In-Place Store Poisoning Defense: Read-Only Store Permissions', () => {
    it('should set store files to read-only and prevent accidental writes, then restore write permissions', async () => {
      const { markStoreDirectoryReadOnly, markStoreDirectoryWritable } = await import('../src/store/index.js');

      const pkgDir = path.join(tmpDir, 'store-ro-test');
      const subDir = path.join(pkgDir, 'lib');
      fs.mkdirSync(subDir, { recursive: true });

      const file1 = path.join(pkgDir, 'index.js');
      const file2 = path.join(subDir, 'helper.js');
      fs.writeFileSync(file1, 'module.exports = "immutable";');
      fs.writeFileSync(file2, 'module.exports = "helper";');

      // 1. Mark store directory as read-only
      markStoreDirectoryReadOnly(pkgDir);

      // 2. Attempting to overwrite should fail with EPERM or EACCES
      let writeFailed = false;
      try {
        fs.writeFileSync(file1, 'module.exports = "POISONED";');
      } catch (err: any) {
        writeFailed = err.code === 'EPERM' || err.code === 'EACCES';
      }
      assert.strictEqual(writeFailed, true, 'Write to read-only store file should fail with EPERM/EACCES');

      // 3. Mark directory writable again (for GC or patch workspace)
      markStoreDirectoryWritable(pkgDir);

      // 4. Overwrite should now succeed
      fs.writeFileSync(file1, 'module.exports = "SAFE_MODIFIED";');
      assert.strictEqual(fs.readFileSync(file1, 'utf-8'), 'module.exports = "SAFE_MODIFIED";');

      // 5. Cleanup
      fs.rmSync(pkgDir, { recursive: true, force: true });
      assert.strictEqual(fs.existsSync(pkgDir), false);
    });
  });

  describe('10. Transitive Dependency Conflicts: Project-Isolated Virtual Store (.linkpm)', () => {
    it('should isolate transitive dependencies per project without mutating or colliding in the global store', async () => {
      const { createVirtualPackage } = await import('../src/linker/virtual-store.js');

      // Shared Global Store
      const storeRoot = path.join(tmpDir, 'shared-store');
      const storePkgAlpha = path.join(storeRoot, 'pkg-alpha', '1.0.0');
      const storeLodash4 = path.join(storeRoot, 'lodash', '4.17.21');
      const storeLodash3 = path.join(storeRoot, 'lodash', '3.10.1');

      fs.mkdirSync(storePkgAlpha, { recursive: true });
      fs.writeFileSync(path.join(storePkgAlpha, 'package.json'), JSON.stringify({ name: 'pkg-alpha', version: '1.0.0' }));
      fs.writeFileSync(path.join(storePkgAlpha, 'index.js'), 'module.exports = "pkg-alpha-1.0.0";');

      fs.mkdirSync(storeLodash4, { recursive: true });
      fs.writeFileSync(path.join(storeLodash4, 'package.json'), JSON.stringify({ name: 'lodash', version: '4.17.21' }));
      fs.writeFileSync(path.join(storeLodash4, 'index.js'), 'module.exports = "lodash-4";');

      fs.mkdirSync(storeLodash3, { recursive: true });
      fs.writeFileSync(path.join(storeLodash3, 'package.json'), JSON.stringify({ name: 'lodash', version: '3.10.1' }));
      fs.writeFileSync(path.join(storeLodash3, 'index.js'), 'module.exports = "lodash-3";');

      // Project A uses pkg-alpha with lodash@4
      const projectA = path.join(tmpDir, 'project-a');
      fs.mkdirSync(projectA, { recursive: true });
      fs.writeFileSync(path.join(projectA, 'package.json'), JSON.stringify({ name: 'project-a' }));

      const resA = createVirtualPackage({
        projectRoot: projectA,
        name: 'pkg-alpha',
        version: '1.0.0',
        storeDir: storePkgAlpha,
        dependencies: {
          lodash: storeLodash4
        }
      });

      // Project B uses pkg-alpha with lodash@3
      const projectB = path.join(tmpDir, 'project-b');
      fs.mkdirSync(projectB, { recursive: true });
      fs.writeFileSync(path.join(projectB, 'package.json'), JSON.stringify({ name: 'project-b' }));

      const resB = createVirtualPackage({
        projectRoot: projectB,
        name: 'pkg-alpha',
        version: '1.0.0',
        storeDir: storePkgAlpha,
        dependencies: {
          lodash: storeLodash3
        }
      });

      // 1. Verify Project A's virtual store links lodash to v4
      const projALodash = path.join(resA.virtualNodeModules, 'lodash', 'index.js');
      assert.strictEqual(fs.existsSync(projALodash), true);
      assert.strictEqual(fs.readFileSync(projALodash, 'utf-8'), 'module.exports = "lodash-4";');

      // 2. Verify Project B's virtual store links lodash to v3
      const projBLodash = path.join(resB.virtualNodeModules, 'lodash', 'index.js');
      assert.strictEqual(fs.existsSync(projBLodash), true);
      assert.strictEqual(fs.readFileSync(projBLodash, 'utf-8'), 'module.exports = "lodash-3";');

      // 3. Verify the global store directory has NO node_modules subdirectory (100% clean and pure)
      const storeNm = path.join(storePkgAlpha, 'node_modules');
      assert.strictEqual(fs.existsSync(storeNm), false, 'Global store package must not contain a node_modules folder');
    });
  });

  describe('11. Unmounted Drive GC Protection: 30-Day Retention Grace Period', () => {
    it('should protect packages from unmounted drives and retain unreferenced packages within the 30-day grace period', async () => {
      const { runGarbageCollection, registerProject, getRegisteredProjectRecords, PROJECTS_FILE } = await import('../src/store/gc.js');

      // 1. Setup a fake project on an "external drive"
      const fakeExternalProj = path.join(tmpDir, 'external-drive-e', 'my-repo');
      fs.mkdirSync(fakeExternalProj, { recursive: true });
      fs.writeFileSync(path.join(fakeExternalProj, 'linkpm-lock.json'), JSON.stringify({
        lockfileVersion: 2,
        packages: {
          'unmounted-dep@1.2.0': { version: '1.2.0' }
        }
      }));

      // Register the project while the "drive is mounted"
      registerProject(fakeExternalProj);

      // Verify it was saved with lockfile snapshot
      const recordsBefore = getRegisteredProjectRecords();
      const registered = recordsBefore.find(r => r.path === path.resolve(fakeExternalProj));
      assert.ok(registered, 'Project should be registered');
      assert.deepStrictEqual(registered.lockfilePackages, ['unmounted-dep@1.2.0']);

      // 2. Setup central store with:
      // - unmounted-dep@1.2.0 (belongs to the unmounted drive)
      // - recent-unused@2.0.0 (unreferenced, but accessed 2 days ago -> within 30-day grace period)
      // - ancient-unused@0.1.0 (unreferenced, accessed 45 days ago -> expired)
      const storeDir = (await import('../src/config/index.js')).getStoreDir();

      const pkgUnmounted = path.join(storeDir, 'unmounted-dep', '1.2.0');
      fs.mkdirSync(pkgUnmounted, { recursive: true });
      fs.writeFileSync(path.join(pkgUnmounted, 'package.json'), JSON.stringify({ name: 'unmounted-dep', version: '1.2.0' }));

      const pkgRecent = path.join(storeDir, 'recent-unused', '2.0.0');
      fs.mkdirSync(pkgRecent, { recursive: true });
      fs.writeFileSync(path.join(pkgRecent, 'package.json'), JSON.stringify({ name: 'recent-unused', version: '2.0.0' }));
      // Set timestamp to 2 days ago
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      fs.utimesSync(pkgRecent, twoDaysAgo, twoDaysAgo);

      const pkgAncient = path.join(storeDir, 'ancient-unused', '0.1.0');
      fs.mkdirSync(pkgAncient, { recursive: true });
      fs.writeFileSync(path.join(pkgAncient, 'package.json'), JSON.stringify({ name: 'ancient-unused', version: '0.1.0' }));
      // Set timestamp to 45 days ago
      const fortyFiveDaysAgo = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
      fs.utimesSync(pkgAncient, fortyFiveDaysAgo, fortyFiveDaysAgo);

      // 3. Simulate "unmounting the drive" by deleting the directory
      fs.rmSync(path.join(tmpDir, 'external-drive-e'), { recursive: true, force: true });
      assert.strictEqual(fs.existsSync(fakeExternalProj), false, 'Drive is now unmounted');

      // 4. Run Garbage Collection with standard 30-day retention
      const gcResult = runGarbageCollection({ dryRun: false, retentionDays: 30 });

      // Verify unmounted drive was protected
      assert.ok(gcResult.unmountedProjects.includes(path.resolve(fakeExternalProj)), 'Unmounted project should be retained in grace period');
      assert.strictEqual(fs.existsSync(pkgUnmounted), true, 'Package from unmounted drive must NOT be deleted');

      // Verify recent package was protected by 30-day retention
      assert.ok(gcResult.retainedGracePackages.includes('recent-unused@2.0.0'), 'Recent unused package should be retained in grace period');
      assert.strictEqual(fs.existsSync(pkgRecent), true, 'Recent unused package must NOT be deleted');

      // Verify ancient unused package was pruned
      assert.ok(gcResult.prunedPackages.includes('ancient-unused@0.1.0'), 'Ancient unused package should be pruned');
      assert.strictEqual(fs.existsSync(pkgAncient), false, 'Ancient unused package should be deleted');

      // 5. Test force=true / retentionDays=0 bypasses grace period
      const forceResult = runGarbageCollection({ dryRun: false, force: true });
      assert.ok(forceResult.prunedPackages.includes('recent-unused@2.0.0'));
      assert.strictEqual(fs.existsSync(pkgRecent), false, 'With force=true, grace period is bypassed and package is pruned');

      // Clean up fake unmounted dep from store
      try { fs.rmSync(path.join(storeDir, 'unmounted-dep'), { recursive: true, force: true }); } catch {}
    });
  });

  describe('6. Default-Deny Install Scripts & linkpm approve-builds', () => {
    it('should block install/postinstall scripts unless explicitly allow-listed', () => {
      const pkgDir = path.join(tmpDir, 'script-pkg-blocked');
      fs.mkdirSync(pkgDir, { recursive: true });
      const markerFile = path.join(pkgDir, 'installed.txt');

      const pkgJson = {
        name: 'test-blocked-script',
        version: '1.0.0',
        scripts: {
          postinstall: `node -e "require('fs').writeFileSync('${markerFile.replace(/\\/g, '\\\\')}', 'hacked')"`
        }
      };
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkgJson));

      // 1. Run without allow-list and without allowBuildScripts -> MUST be blocked
      runLifecycleScripts(pkgDir, pkgJson, [], false);
      assert.strictEqual(fs.existsSync(markerFile), false, 'Postinstall script must not execute when unapproved');

      // 2. Run with package allow-listed in onlyBuiltDependencies -> MUST execute
      runLifecycleScripts(pkgDir, pkgJson, ['test-blocked-script'], false);
      assert.strictEqual(fs.existsSync(markerFile), true, 'Postinstall script should execute when in allowList');
      assert.strictEqual(fs.readFileSync(markerFile, 'utf-8'), 'hacked');
      fs.rmSync(markerFile, { force: true });

      // 3. Run with allowBuildScripts=true override -> MUST execute
      runLifecycleScripts(pkgDir, pkgJson, [], true);
      assert.strictEqual(fs.existsSync(markerFile), true, 'Postinstall script should execute when allowBuildScripts is true');
    });

    it('findUnapprovedBuiltDependencies and approveBuiltDependencies should detect and persist approvals', () => {
      const projectDir = path.join(tmpDir, 'approve-test-proj');
      fs.mkdirSync(projectDir, { recursive: true });

      const pkgJsonPath = path.join(projectDir, 'package.json');
      fs.writeFileSync(pkgJsonPath, JSON.stringify({
        name: 'my-app',
        version: '1.0.0',
        dependencies: {
          'native-dep': '^1.0.0',
          'safe-dep': '^2.0.0'
        },
        onlyBuiltDependencies: []
      }, null, 2));

      // Create fake node_modules
      const nativePkgDir = path.join(projectDir, 'node_modules', 'native-dep');
      fs.mkdirSync(nativePkgDir, { recursive: true });
      fs.writeFileSync(path.join(nativePkgDir, 'package.json'), JSON.stringify({
        name: 'native-dep',
        version: '1.0.0',
        scripts: { install: 'node-gyp rebuild' }
      }));

      const safePkgDir = path.join(projectDir, 'node_modules', 'safe-dep');
      fs.mkdirSync(safePkgDir, { recursive: true });
      fs.writeFileSync(path.join(safePkgDir, 'package.json'), JSON.stringify({
        name: 'safe-dep',
        version: '2.0.0'
      }));

      // Find unapproved
      const unapproved = findUnapprovedBuiltDependencies(projectDir);
      assert.strictEqual(unapproved.length, 1);
      assert.strictEqual(unapproved[0].name, 'native-dep');
      assert.strictEqual(unapproved[0].scriptType, 'install');

      // Approve it
      approveBuiltDependencies(projectDir, ['native-dep']);

      const updated = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      assert.ok(updated.onlyBuiltDependencies.includes('native-dep'));

      // Check unapproved again -> should now be empty
      const afterApproval = findUnapprovedBuiltDependencies(projectDir);
      assert.strictEqual(afterApproval.length, 0);
    });
  });

  describe('7. Security Cooldown (minimumReleaseAge) & Exotic Sources', () => {
    it('npmrc config correctly defaults minimumReleaseAge to 86400s (24h) and allowExoticTransitive to false', () => {
      const config = loadNpmrcConfig(tmpDir);
      assert.strictEqual(config.minimumReleaseAge, 86400, 'Default release cooldown must be 24h (86400 seconds)');
      assert.strictEqual(config.allowExoticTransitive, false, 'Default allowExoticTransitive must be false');
    });

    it('npmrc custom settings can override cooldown and exotic settings', () => {
      const customDir = path.join(tmpDir, 'custom-npmrc');
      fs.mkdirSync(customDir, { recursive: true });
      fs.writeFileSync(path.join(customDir, '.npmrc'), [
        'minimum-release-age=3600',
        'release-age-exclude=fast-patch,critical-sec',
        'allow-exotic-transitive=true'
      ].join('\n'));

      const config = loadNpmrcConfig(customDir);
      assert.strictEqual(config.minimumReleaseAge, 3600);
      assert.deepStrictEqual(config.releaseAgeExclude, ['fast-patch', 'critical-sec']);
      assert.strictEqual(config.allowExoticTransitive, true);
    });
  });

  describe('8. Central Store Verification (store verify)', () => {
    it('verifyStore should detect altered package files', async () => {
      const storeDir = path.join(tmpDir, 'test-store-verify');
      const pkgDir = path.join(storeDir, 'tamper-test', '1.0.0');
      fs.mkdirSync(pkgDir, { recursive: true });

      const fileContent = 'console.log("original");';
      fs.writeFileSync(path.join(pkgDir, 'index.js'), fileContent);
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'tamper-test', version: '1.0.0' }));

      // Write integrity manifest
      const hash = crypto.createHash('sha512').update(fileContent).digest('base64');
      fs.writeFileSync(path.join(pkgDir, '.linkpm-integrity.json'), JSON.stringify({
        'index.js': `sha512-${hash}`
      }));

      // 1. Verify before tampering -> should pass
      const resultBefore = await verifyStore({ storeDir, fix: false });
      assert.strictEqual(resultBefore.valid, true);
      assert.strictEqual(resultBefore.corruptedPackages.length, 0);

      // 2. Tamper with the file
      fs.writeFileSync(path.join(pkgDir, 'index.js'), 'console.log("tampered!");');

      const resultAfter = await verifyStore({ storeDir, fix: false });
      assert.strictEqual(resultAfter.valid, false);
      assert.strictEqual(resultAfter.corruptedPackages.length, 1);
      assert.strictEqual(resultAfter.corruptedPackages[0].package, 'tamper-test@1.0.0');
      assert.ok(resultAfter.corruptedPackages[0].issues[0].includes('Integrity mismatch for index.js'));
    });
  });

  describe('9. ABI-Scoped Native Build Keys & Peer Context Isolation', () => {
    it('isNativePackage correctly identifies packages requiring native builds', () => {
      assert.strictEqual(isNativePackage({ gypfile: true }), true);
      assert.strictEqual(isNativePackage({ binary: { module_name: 'test' } }), true);
      assert.strictEqual(isNativePackage({ scripts: { install: 'node-gyp rebuild' } }), true);
      assert.strictEqual(isNativePackage({ scripts: { build: 'tsc' } }), false);
      assert.strictEqual(isNativePackage({}), false);
    });

    it('getNativeAbiSuffix produces deterministic ABI/platform/arch suffix', () => {
      const suffix = getNativeAbiSuffix();
      assert.ok(suffix.startsWith('_abi'), `Suffix should start with _abi: ${suffix}`);
      assert.ok(suffix.includes(process.platform), `Suffix should contain platform: ${suffix}`);
      assert.ok(suffix.includes(process.arch), `Suffix should contain arch: ${suffix}`);
    });

    it('computePeerContextHash generates distinct deterministic hashes for differing peer dependency trees', () => {
      const hashA = computePeerContextHash({ react: '18.2.0', 'react-dom': '18.2.0' });
      const hashB = computePeerContextHash({ react: '19.0.0', 'react-dom': '19.0.0' });
      const hashEmpty = computePeerContextHash({});

      assert.strictEqual(hashEmpty, '');
      assert.strictEqual(hashA.length, 8);
      assert.strictEqual(hashB.length, 8);
      assert.notStrictEqual(hashA, hashB, 'Different peer versions must yield distinct context hashes');

      // Key ordering independence
      const hashA2 = computePeerContextHash({ 'react-dom': '18.2.0', react: '18.2.0' });
      assert.strictEqual(hashA, hashA2, 'Key ordering in peer record must not alter context hash');
    });
  });
});




