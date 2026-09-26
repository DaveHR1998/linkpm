import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNpmrcContent, getRegistryForPackage, getAuthHeaderForRegistry, type NpmrcConfig } from '../src/config/npmrc.js';

test('parseNpmrcContent parses comments, keys, and values', () => {
  const content = `
    # This is a comment
    ; Semicolon comment
    registry = https://registry.npmjs.org/
    @myorg:registry = https://npm.myorg.internal/
    //registry.npmjs.org/:_authToken = secret_token_123
    strict-ssl = false
  `;

  const parsed = parseNpmrcContent(content);
  assert.equal(parsed['registry'], 'https://registry.npmjs.org/');
  assert.equal(parsed['@myorg:registry'], 'https://npm.myorg.internal/');
  assert.equal(parsed['//registry.npmjs.org/:_authToken'], 'secret_token_123');
  assert.equal(parsed['strict-ssl'], 'false');
});

test('getRegistryForPackage routes scoped packages correctly', () => {
  const npmrc: NpmrcConfig = {
    registry: 'https://registry.npmjs.org/',
    scopedRegistries: {
      '@myorg': 'https://npm.myorg.internal/'
    },
    authTokens: {},
    strictSsl: true,
    raw: {}
  };

  assert.equal(getRegistryForPackage('react', npmrc), 'https://registry.npmjs.org/');
  assert.equal(getRegistryForPackage('@types/node', npmrc), 'https://registry.npmjs.org/');
  assert.equal(getRegistryForPackage('@myorg/core', npmrc), 'https://npm.myorg.internal/');
});

test('getAuthHeaderForRegistry extracts correct bearer token', () => {
  const npmrc: NpmrcConfig = {
    registry: 'https://registry.npmjs.org/',
    scopedRegistries: {},
    authTokens: {
      'registry.npmjs.org': 'my_token_abc'
    },
    strictSsl: true,
    raw: {}
  };

  const header = getAuthHeaderForRegistry('https://registry.npmjs.org/', npmrc);
  assert.equal(header, 'Bearer my_token_abc');
});
