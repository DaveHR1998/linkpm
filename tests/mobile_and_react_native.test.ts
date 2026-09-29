import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getLinkerMode } from '../src/config/npmrc.js';
import { linkPackage } from '../src/linker.js';
import { linkHoistedPackage, hoistDependencies, copyOrHardlinkPackage } from '../src/linker/hoisted.js';
import { initMetroConfig, withLinkPM } from '../src/metro/index.js';
import { getStoreDir } from '../src/config/index.js';

test('Mobile & React Native: getLinkerMode precedence and configuration', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkpm-linker-test-'));

  try {
    // 1. Default fallback is junction
    assert.equal(getLinkerMode(tmpDir), 'junction');

    // 2. .linkpmrc config file: linker = hoisted
    const linkpmrcPath = path.join(tmpDir, '.linkpmrc');
    fs.writeFileSync(linkpmrcPath, 'linker = hoisted\n', 'utf-8');
    assert.equal(getLinkerMode(tmpDir), 'hoisted');
    fs.unlinkSync(linkpmrcPath);

    // 3. package.json linkpm.linker = hoisted
    const pkgPath = path.join(tmpDir, 'package.json');
    fs.writeFileSync(pkgPath, JSON.stringify({ name: 'test-app', linkpm: { linker: 'hoisted' } }), 'utf-8');
    assert.equal(getLinkerMode(tmpDir), 'hoisted');

    // 4. package.json top-level linker = hoisted
    fs.writeFileSync(pkgPath, JSON.stringify({ name: 'test-app', linker: 'hoisted' }), 'utf-8');
    assert.equal(getLinkerMode(tmpDir), 'hoisted');

    // 5. Explicit CLI option overrides package.json
    assert.equal(getLinkerMode(tmpDir, 'junction'), 'junction');
    assert.equal(getLinkerMode(tmpDir, 'hoisted'), 'hoisted');

    // 6. Environment variable LINKPM_LINKER
    process.env.LINKPM_LINKER = 'hoisted';
    assert.equal(getLinkerMode(tmpDir), 'hoisted');
    process.env.LINKPM_LINKER = 'junction';
    assert.equal(getLinkerMode(tmpDir), 'junction');
    delete process.env.LINKPM_LINKER;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Mobile & React Native: linkHoistedPackage creates flat real directory whose realpath is inside project', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkpm-hoisted-test-'));
  const storePkgDir = path.join(tmpDir, 'store', 'react@18.2.0');
  fs.mkdirSync(storePkgDir, { recursive: true });

  // Create mock package in store
  fs.writeFileSync(
    path.join(storePkgDir, 'package.json'),
    JSON.stringify({
      name: 'react',
      version: '18.2.0',
      main: 'index.js',
      bin: { 'react-cli': 'cli.js' }
    }),
    'utf-8'
  );
  fs.writeFileSync(path.join(storePkgDir, 'index.js'), 'module.exports = "React18";', 'utf-8');
  fs.writeFileSync(path.join(storePkgDir, 'cli.js'), 'console.log("react");', 'utf-8');

  try {
    const projectDir = path.join(tmpDir, 'my-react-native-app');
    fs.mkdirSync(projectDir, { recursive: true });

    // Link in hoisted mode
    const res = linkPackage(projectDir, 'react', storePkgDir, { linker: 'hoisted' });
    assert.equal(res.packageName, 'react');

    const installedPkgDir = path.join(projectDir, 'node_modules', 'react');
    assert.ok(fs.existsSync(installedPkgDir), 'node_modules/react should exist');

    // CRITICAL: Verify fs.realpath resolves inside project node_modules and NOT inside store
    const realPath = fs.realpathSync(installedPkgDir);
    const realProjectDir = fs.realpathSync(projectDir);
    assert.ok(
      realPath.toLowerCase().startsWith(realProjectDir.toLowerCase()),
      `fs.realpath (${realPath}) must resolve within projectDir (${realProjectDir}) for Metro compatibility`
    );

    // Verify files were accurately transferred
    assert.equal(
      fs.readFileSync(path.join(installedPkgDir, 'index.js'), 'utf-8'),
      'module.exports = "React18";'
    );

    // Verify binary was linked
    const binPath = path.join(projectDir, 'node_modules', '.bin', 'react-cli');
    assert.ok(fs.existsSync(binPath) || fs.existsSync(`${binPath}.cmd`));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Mobile & React Native: hoistDependencies flattens transitive packages and handles conflicts', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkpm-transitive-hoist-'));

  // Create store directories for dependencies
  const looseEnvifyStore = path.join(tmpDir, 'store', 'loose-envify@1.4.0');
  const jsTokensStore = path.join(tmpDir, 'store', 'js-tokens@4.0.0');
  const jsTokensLegacyStore = path.join(tmpDir, 'store', 'js-tokens@3.0.0');

  fs.mkdirSync(looseEnvifyStore, { recursive: true });
  fs.mkdirSync(jsTokensStore, { recursive: true });
  fs.mkdirSync(jsTokensLegacyStore, { recursive: true });

  fs.writeFileSync(path.join(looseEnvifyStore, 'package.json'), JSON.stringify({ name: 'loose-envify', version: '1.4.0' }), 'utf-8');
  fs.writeFileSync(path.join(jsTokensStore, 'package.json'), JSON.stringify({ name: 'js-tokens', version: '4.0.0' }), 'utf-8');
  fs.writeFileSync(path.join(jsTokensLegacyStore, 'package.json'), JSON.stringify({ name: 'js-tokens', version: '3.0.0' }), 'utf-8');

  try {
    const projectDir = path.join(tmpDir, 'rn-project');
    fs.mkdirSync(projectDir, { recursive: true });

    // 1. Hoist root dependencies
    const count = hoistDependencies(projectDir, [
      { name: 'loose-envify', version: '1.4.0', storeDir: looseEnvifyStore },
      { name: 'js-tokens', version: '4.0.0', storeDir: jsTokensStore }
    ]);
    assert.equal(count, 2);

    assert.ok(fs.existsSync(path.join(projectDir, 'node_modules', 'loose-envify')));
    assert.ok(fs.existsSync(path.join(projectDir, 'node_modules', 'js-tokens')));

    // 2. Hoist conflicting version of js-tokens (v3.0.0 required by legacy-pkg)
    const legacyPkgDir = path.join(projectDir, 'node_modules', 'legacy-pkg');
    fs.mkdirSync(legacyPkgDir, { recursive: true });
    fs.writeFileSync(path.join(legacyPkgDir, 'package.json'), JSON.stringify({ name: 'legacy-pkg', version: '1.0.0' }), 'utf-8');

    hoistDependencies(projectDir, [
      { name: 'js-tokens', version: '3.0.0', storeDir: jsTokensLegacyStore, parentName: 'legacy-pkg' }
    ]);

    // Root js-tokens should stay v4.0.0
    const rootTokens = JSON.parse(fs.readFileSync(path.join(projectDir, 'node_modules', 'js-tokens', 'package.json'), 'utf-8'));
    assert.equal(rootTokens.version, '4.0.0');

    // Conflicting js-tokens should nest inside legacy-pkg/node_modules/js-tokens
    const nestedTokensPath = path.join(legacyPkgDir, 'node_modules', 'js-tokens', 'package.json');
    assert.ok(fs.existsSync(nestedTokensPath), 'Conflicting dependency must nest in parent node_modules');
    const nestedTokens = JSON.parse(fs.readFileSync(nestedTokensPath, 'utf-8'));
    assert.equal(nestedTokens.version, '3.0.0');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Mobile & React Native: initMetroConfig creates clean metro.config.js when none exists', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkpm-metro-init-'));

  try {
    const res = initMetroConfig(tmpDir);
    assert.equal(res.created, true);
    assert.equal(res.updated, false);

    const configContent = fs.readFileSync(res.filePath, 'utf-8');
    assert.ok(configContent.includes('unstable_enableSymlinks: true'));
    assert.ok(configContent.includes('watchFolders: [linkpmStorePath]'));
    assert.ok(configContent.includes('nodeModulesPaths: [path.resolve(__dirname, \'node_modules\')]'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Mobile & React Native: initMetroConfig injects non-destructive helper into existing metro.config.js', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkpm-metro-existing-'));
  const metroFile = path.join(tmpDir, 'metro.config.js');

  const existingConfig = `const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const config = { transformer: { getTransformOptions: async () => ({}) } };
module.exports = mergeConfig(getDefaultConfig(__dirname), config);
`;
  fs.writeFileSync(metroFile, existingConfig, 'utf-8');

  try {
    const res = initMetroConfig(tmpDir);
    assert.equal(res.created, false);
    assert.equal(res.updated, true);

    const updatedContent = fs.readFileSync(metroFile, 'utf-8');
    assert.ok(updatedContent.includes('// [linkpm-metro-helper] Auto-configured by "linkpm metro-init"'));
    assert.ok(updatedContent.includes('unstable_enableSymlinks: true'));
    assert.ok(updatedContent.includes('_linkpmStore'));

    // Running again should detect already configured and do nothing
    const secondRun = initMetroConfig(tmpDir);
    assert.equal(secondRun.created, false);
    assert.equal(secondRun.updated, false);
    assert.ok(secondRun.message.includes('already configured'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Mobile & React Native: withLinkPM programmatically wraps Metro configuration object', () => {
  const baseConfig = {
    watchFolders: ['/some/custom/path'],
    resolver: {
      sourceExts: ['jsx', 'js', 'ts', 'tsx']
    }
  };

  const storeDir = getStoreDir();
  const wrapped = withLinkPM(baseConfig, { storeDir, projectRoot: '/mock/rn-app' });

  assert.ok(wrapped.watchFolders.includes('/some/custom/path'));
  assert.ok(wrapped.watchFolders.includes(storeDir));
  assert.equal(wrapped.resolver.unstable_enableSymlinks, true);
  assert.ok(wrapped.resolver.nodeModulesPaths.some((p: string) => p.includes('node_modules')));
  assert.deepEqual(wrapped.resolver.sourceExts, ['jsx', 'js', 'ts', 'tsx']);
});
