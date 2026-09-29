import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeLockfile, syncNpmPackageLock, LockfileV2 } from '../src/lockfile/index.js';
import { deployProject } from '../src/deploy.js';

test('Production & Serverless: Automatic Lockfile Mirroring writes valid package-lock.json (v3)', () => {
  const tmpDir = path.join(os.tmpdir(), `linkpm-mirror-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({
      name: 'serverless-api',
      version: '2.1.0',
      dependencies: { express: '^4.19.2' },
      devDependencies: { typescript: '^5.4.0' }
    })
  );

  const lockfile: LockfileV2 = {
    lockfileVersion: 2,
    packages: {
      'express@4.19.2': {
        version: '4.19.2',
        resolved: 'https://registry.npmjs.org/express/-/express-4.19.2.tgz',
        integrity: 'sha512-test-hash',
        isDev: false,
        dependencies: { accepts: '1.3.8' }
      },
      'typescript@5.4.0': {
        version: '5.4.0',
        resolved: 'https://registry.npmjs.org/typescript/-/typescript-5.4.0.tgz',
        integrity: 'sha512-ts-hash',
        isDev: true
      }
    }
  };

  // writeLockfile writes both linkpm-lock.json and package-lock.json
  writeLockfile(tmpDir, lockfile);

  const linkpmLockPath = path.join(tmpDir, 'linkpm-lock.json');
  const npmLockPath = path.join(tmpDir, 'package-lock.json');

  assert.ok(fs.existsSync(linkpmLockPath), 'linkpm-lock.json must exist');
  assert.ok(fs.existsSync(npmLockPath), 'package-lock.json must exist');

  const npmLock = JSON.parse(fs.readFileSync(npmLockPath, 'utf-8'));
  assert.equal(npmLock.lockfileVersion, 3, 'Must be lockfileVersion 3 for Vercel/Netlify/npm v7+ compatibility');
  assert.equal(npmLock.name, 'serverless-api');
  assert.ok(npmLock.packages['']);
  assert.ok(npmLock.packages['node_modules/express']);
  assert.equal(npmLock.packages['node_modules/express'].version, '4.19.2');
  assert.equal(npmLock.packages['node_modules/express'].resolved, 'https://registry.npmjs.org/express/-/express-4.19.2.tgz');
  assert.equal(npmLock.packages['node_modules/express'].integrity, 'sha512-test-hash');

  assert.ok(npmLock.packages['node_modules/typescript']);
  assert.equal(npmLock.packages['node_modules/typescript'].dev, true);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Production & Serverless: linkpm deploy isolates production dependencies and dereferences all junctions/symlinks', async () => {
  const tmpProject = path.join(os.tmpdir(), `linkpm-deploy-test-${Date.now()}`);
  const storePkg = path.join(tmpProject, 'fake-store', 'fastify');
  const nmPkg = path.join(tmpProject, 'node_modules', 'fastify');

  fs.mkdirSync(storePkg, { recursive: true });
  fs.mkdirSync(path.dirname(nmPkg), { recursive: true });

  fs.writeFileSync(path.join(storePkg, 'package.json'), JSON.stringify({ name: 'fastify', version: '4.26.0' }));
  fs.writeFileSync(path.join(storePkg, 'index.js'), 'module.exports = { fastify: true };');

  // Create junction / symlink in project node_modules
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(storePkg, nmPkg, linkType);

  fs.writeFileSync(
    path.join(tmpProject, 'package.json'),
    JSON.stringify({
      name: 'lambda-function',
      version: '1.0.0',
      dependencies: { fastify: '^4.26.0' },
      devDependencies: { vitest: '^1.0.0' }
    })
  );

  fs.writeFileSync(path.join(tmpProject, 'server.js'), 'console.log("running lambda");');

  // Execute deployProject
  const res = await deployProject(tmpProject, {
    outDir: 'dist-lambda',
    prod: true
  });

  assert.ok(fs.existsSync(res.outDir));
  assert.ok(res.packagesCount >= 1);

  // Check that application files were copied
  assert.ok(fs.existsSync(path.join(res.outDir, 'server.js')));
  const deployPkgJson = JSON.parse(fs.readFileSync(path.join(res.outDir, 'package.json'), 'utf-8'));
  assert.ok(deployPkgJson.dependencies['fastify']);
  assert.equal(deployPkgJson.devDependencies, undefined, 'devDependencies must be stripped in prod deploy');

  // Verify that the deployed node_modules/fastify is a REAL physical directory (not a junction/symlink)
  const deployedFastify = path.join(res.outDir, 'node_modules', 'fastify');
  assert.ok(fs.existsSync(deployedFastify));
  assert.ok(fs.existsSync(path.join(deployedFastify, 'index.js')));

  // Check stat vs lstat: in a dereferenced copy, lstat is a regular directory, NOT a symbolic link / junction!
  const lstat = fs.lstatSync(deployedFastify);
  assert.equal(lstat.isSymbolicLink(), false, 'Deployed package must be a physical dereferenced directory');
  assert.equal(lstat.isDirectory(), true);

  fs.rmSync(tmpProject, { recursive: true, force: true });
});
