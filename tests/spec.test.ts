import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePackageSpec } from '../src/resolver/spec.js';

test('parsePackageSpec handles standard unscoped packages', () => {
  const spec1 = parsePackageSpec('express');
  assert.equal(spec1.type, 'registry');
  assert.equal(spec1.name, 'express');
  assert.equal(spec1.range, 'latest');

  const spec2 = parsePackageSpec('express@^4.18.2');
  assert.equal(spec2.type, 'registry');
  assert.equal(spec2.name, 'express');
  assert.equal(spec2.range, '^4.18.2');
});

test('parsePackageSpec handles scoped packages', () => {
  const spec = parsePackageSpec('@types/node@18.0.0');
  assert.equal(spec.type, 'registry');
  assert.equal(spec.name, '@types/node');
  assert.equal(spec.range, '18.0.0');
});

test('parsePackageSpec handles aliases', () => {
  const spec = parsePackageSpec('my-react@npm:react@^18.2.0');
  assert.equal(spec.type, 'alias');
  assert.equal(spec.alias, 'my-react');
  assert.equal(spec.name, 'react');
  assert.equal(spec.range, '^18.2.0');
});

test('parsePackageSpec handles workspace protocol', () => {
  const spec = parsePackageSpec('workspace:^1.2.0');
  assert.equal(spec.type, 'workspace');
  assert.equal(spec.range, '^1.2.0');
});

test('parsePackageSpec handles local paths', () => {
  const fileSpec = parsePackageSpec('file:../common');
  assert.equal(fileSpec.type, 'file');
  assert.equal(fileSpec.target, '../common');

  const linkSpec = parsePackageSpec('link:../../pkg');
  assert.equal(linkSpec.type, 'link');
  assert.equal(linkSpec.target, '../../pkg');
});

test('parsePackageSpec handles git and tarballs', () => {
  const gitSpec = parsePackageSpec('github:user/repo');
  assert.equal(gitSpec.type, 'git');
  assert.equal(gitSpec.target, 'https://github.com/user/repo.git');

  const tarballSpec = parsePackageSpec('https://example.com/foo.tgz');
  assert.equal(tarballSpec.type, 'tarball');
  assert.equal(tarballSpec.target, 'https://example.com/foo.tgz');
});
