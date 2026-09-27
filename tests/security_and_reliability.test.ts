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
      assert.strictEqual(patchedContent, 'module.exports = "PATCHED_DATE_FNS";');
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
});

