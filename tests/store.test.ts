import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileLock } from '../src/store/lock.js';
import { registerProject, getRegisteredProjects, runGarbageCollection, PROJECTS_FILE } from '../src/store/gc.js';

test('FileLock acquires, runs task, and cleans up lockfile', async () => {
  const tmpLock = path.join(os.tmpdir(), `linkpm-lock-test-${Date.now()}.lock`);

  let executed = false;
  const result = await FileLock.withLock(tmpLock, async () => {
    assert.ok(fs.existsSync(tmpLock), 'Lockfile should exist during execution');
    executed = true;
    return 42;
  });

  assert.equal(executed, true);
  assert.equal(result, 42);
  assert.equal(fs.existsSync(tmpLock), false, 'Lockfile should be removed after execution');
});

test('FileLock recovers from stale lock older than timeout', async () => {
  const tmpLock = path.join(os.tmpdir(), `linkpm-stale-lock-${Date.now()}.lock`);

  // Write a fake stale lock with PID 999999 and timestamp from 2 minutes ago
  fs.writeFileSync(tmpLock, JSON.stringify({
    pid: 999999,
    timestamp: Date.now() - 120000
  }));

  const result = await FileLock.withLock(tmpLock, async () => {
    return 'recovered';
  }, { staleTimeoutMs: 5000 });

  assert.equal(result, 'recovered');
  assert.equal(fs.existsSync(tmpLock), false);
});

test('registerProject persists project directory to projects.json', () => {
  const fakeProject = path.join(os.tmpdir(), `linkpm-fake-project-${Date.now()}`);
  registerProject(fakeProject);

  const list = getRegisteredProjects();
  assert.ok(list.includes(path.resolve(fakeProject)));
});

test('runGarbageCollection in dry-run mode returns stats without deletion', () => {
  const res = runGarbageCollection({ dryRun: true });
  assert.ok(Array.isArray(res.activeProjects));
  assert.equal(typeof res.totalStorePackages, 'number');
  assert.equal(typeof res.prunedCount, 'number');
  assert.equal(typeof res.freedBytes, 'number');
});
