import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initIdeConfig, checkIdeDiagnostics } from '../src/ide/index.js';
import { runDoctor } from '../src/diagnostics/doctor.js';

test('IDE Integration: initIdeConfig creates .vscode/settings.json and updates tsconfig.json', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkpm-ide-test-'));

  try {
    // 1. Initial state: check diagnostics flags missing settings
    const initialDiag = checkIdeDiagnostics(tmpDir);
    assert.equal(initialDiag.hasVscodeSettings, false);
    assert.equal(initialDiag.hasTsdkConfigured, false);
    assert.equal(initialDiag.isReady, false);

    // Create a mock tsconfig.json without preserveSymlinks
    const tsconfigPath = path.join(tmpDir, 'tsconfig.json');
    fs.writeFileSync(
      tsconfigPath,
      JSON.stringify({ compilerOptions: { target: 'es2022', module: 'nodenext' } }, null, 2),
      'utf-8'
    );

    // 2. Run initIdeConfig
    const res = initIdeConfig(tmpDir);
    assert.equal(res.vscodeCreated, true);
    assert.equal(res.tsconfigUpdated, true);

    // Verify .vscode/settings.json
    const settingsPath = path.join(tmpDir, '.vscode', 'settings.json');
    assert.ok(fs.existsSync(settingsPath));
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.equal(settings['typescript.tsdk'], 'node_modules/typescript/lib');
    assert.equal(settings['typescript.npm'], 'linkpm');
    assert.equal(settings['typescript.preferences.includePackageJsonAutoImports'], 'auto');

    // Verify tsconfig.json preserveSymlinks
    const updatedTsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8'));
    assert.equal(updatedTsconfig.compilerOptions.preserveSymlinks, true);

    // 3. Post-init: check diagnostics reports ready
    const readyDiag = checkIdeDiagnostics(tmpDir);
    assert.equal(readyDiag.hasVscodeSettings, true);
    assert.equal(readyDiag.hasTsdkConfigured, true);
    assert.equal(readyDiag.hasPreserveSymlinks, true);
    assert.equal(readyDiag.isReady, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('IDE Integration: preserves existing custom settings and comments in .vscode/settings.json', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkpm-ide-merge-'));
  const vscodeDir = path.join(tmpDir, '.vscode');
  fs.mkdirSync(vscodeDir, { recursive: true });

  const settingsPath = path.join(vscodeDir, 'settings.json');
  // Write existing settings with custom user preferences
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ 'editor.tabSize': 2, 'files.autoSave': 'onFocusChange' }, null, 2),
    'utf-8'
  );

  try {
    const res = initIdeConfig(tmpDir);
    assert.equal(res.vscodeCreated, false);
    assert.equal(res.vscodeUpdated, true);

    const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    // Custom settings preserved
    assert.equal(merged['editor.tabSize'], 2);
    assert.equal(merged['files.autoSave'], 'onFocusChange');
    // LinkPM TypeScript LSP settings injected
    assert.equal(merged['typescript.tsdk'], 'node_modules/typescript/lib');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('IDE Integration: runDoctor detects IDE settings and --fix auto-repairs them', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkpm-doctor-fix-'));
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'fix-test' }), 'utf-8');

  try {
    // 1. Without fix: should warn about IDE settings
    const checksBefore = await runDoctor(tmpDir, { fix: false });
    const ideCheckBefore = checksBefore.find(c => c.name === 'IDE & TypeScript LSP');
    assert.ok(ideCheckBefore);
    assert.equal(ideCheckBefore.status, 'warn');

    // 2. With fix: should automatically configure and pass
    const checksAfter = await runDoctor(tmpDir, { fix: true });
    const ideCheckAfter = checksAfter.find(c => c.name === 'IDE & TypeScript LSP');
    assert.ok(ideCheckAfter);
    assert.equal(ideCheckAfter.status, 'pass');

    // Verify .vscode/settings.json was created by doctor --fix
    const settingsPath = path.join(tmpDir, '.vscode', 'settings.json');
    assert.ok(fs.existsSync(settingsPath));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
