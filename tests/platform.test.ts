import test from 'node:test';
import assert from 'node:assert/strict';
import { isPlatformSupported, isEngineSupported, shouldSkipOptionalPackage } from '../src/resolver/platform.js';

test('isPlatformSupported validates OS and CPU with negations', () => {
  const winEnv = { os: 'win32', arch: 'x64', nodeVersion: 'v20.0.0' };
  const macEnv = { os: 'darwin', arch: 'arm64', nodeVersion: 'v20.0.0' };

  // Darwin only
  assert.equal(isPlatformSupported({ os: ['darwin'] }, winEnv), false);
  assert.equal(isPlatformSupported({ os: ['darwin'] }, macEnv), true);

  // Negation: !win32
  assert.equal(isPlatformSupported({ os: ['!win32'] }, winEnv), false);
  assert.equal(isPlatformSupported({ os: ['!win32'] }, macEnv), true);

  // CPU
  assert.equal(isPlatformSupported({ cpu: ['arm64'] }, winEnv), false);
  assert.equal(isPlatformSupported({ cpu: ['arm64'] }, macEnv), true);
});

test('isEngineSupported validates node semver range', () => {
  const env = { os: 'win32', arch: 'x64', nodeVersion: 'v20.10.0' };

  const pass = isEngineSupported({ node: '>=18.0.0' }, env);
  assert.equal(pass.supported, true);

  const fail = isEngineSupported({ node: '>=22.0.0' }, env);
  assert.equal(fail.supported, false);
});

test('shouldSkipOptionalPackage skips non-matching binary packages', () => {
  const winEnv = { os: 'win32', arch: 'x64', nodeVersion: 'v20.0.0' };

  // Linux package on Windows
  assert.equal(shouldSkipOptionalPackage('@rollup/rollup-linux-x64-gnu', undefined, winEnv), true);

  // Windows package on Windows
  assert.equal(shouldSkipOptionalPackage('@rollup/rollup-win32-x64-msvc', undefined, winEnv), false);
});
