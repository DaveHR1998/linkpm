import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildScriptEnv, runScript, execBin } from '../src/scripts/index.js';
import { LinkPMError } from '../src/utils/errors.js';

test('buildScriptEnv populates PATH and lifecycle variables', () => {
  const tmpDir = path.join(os.tmpdir(), `linkpm-env-test-${Date.now()}`);
  const nmBin = path.join(tmpDir, 'node_modules', '.bin');
  fs.mkdirSync(nmBin, { recursive: true });

  const env = buildScriptEnv(tmpDir, {
    lifecycleEvent: 'build',
    pkgJson: { name: 'sample-project', version: '2.5.0' }
  });

  assert.ok(env.PATH?.includes(nmBin));
  assert.equal(env.npm_lifecycle_event, 'build');
  assert.equal(env.npm_package_name, 'sample-project');
  assert.equal(env.npm_package_version, '2.5.0');
  assert.equal(env.INIT_CWD, process.cwd());

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('runScript executes pre, main, and post hooks in sequence', async () => {
  const tmpDir = path.join(os.tmpdir(), `linkpm-run-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const traceFile = path.join(tmpDir, 'trace.txt');

  // Cross-platform node script commands to append lines to trace.txt
  const nodeAppend = (text: string) => `node -e "require('fs').appendFileSync('trace.txt', '${text}\\n')"`;

  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({
      name: 'test-runner-app',
      version: '1.0.0',
      scripts: {
        precompile: nodeAppend('pre'),
        compile: nodeAppend('main'),
        postcompile: nodeAppend('post')
      }
    })
  );

  const res = await runScript(tmpDir, 'compile', { silent: true });
  assert.equal(res.success, true);
  assert.equal(res.exitCode, 0);

  const traceContent = fs.readFileSync(traceFile, 'utf-8').trim().split(/\r?\n/);
  assert.deepEqual(traceContent, ['pre', 'main', 'post']);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('runScript respects --if-present for non-existent scripts', async () => {
  const tmpDir = path.join(os.tmpdir(), `linkpm-ifpresent-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({
      name: 'app',
      scripts: { build: 'echo build' }
    })
  );

  // If present: true -> should succeed silently
  const res = await runScript(tmpDir, 'nonexistent', { ifPresent: true });
  assert.equal(res.success, true);
  assert.equal(res.exitCode, 0);

  // If present: false -> should throw LinkPMError
  await assert.rejects(
    async () => {
      await runScript(tmpDir, 'nonexistent', { ifPresent: false });
    },
    (err: any) => {
      assert.ok(err instanceof LinkPMError);
      assert.equal(err.code, 'ERR_COMMAND_FAILED');
      return true;
    }
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('runScript respects --ignore-scripts', async () => {
  const tmpDir = path.join(os.tmpdir(), `linkpm-ignore-scripts-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({
      name: 'app',
      scripts: { test: 'node -e "process.exit(1)"' }
    })
  );

  const res = await runScript(tmpDir, 'test', { ignoreScripts: true });
  assert.equal(res.success, true);
  assert.equal(res.exitCode, 0);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('execBin runs node commands with inherited project environment', () => {
  const tmpDir = path.join(os.tmpdir(), `linkpm-exec-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const code = execBin(tmpDir, 'node', ['-e', '"process.exit(0)"']);
  assert.equal(code, 0);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
