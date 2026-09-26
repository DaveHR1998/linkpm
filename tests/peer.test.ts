import test from 'node:test';
import assert from 'node:assert/strict';
import { DependencyGraph, type DependencyNode } from '../src/graph/index.js';
import { PeerEngine } from '../src/resolver/peer.js';

test('PeerEngine detects conflicting peer dependencies', () => {
  const graph = new DependencyGraph();

  // Root has react@18.2.0
  const reactNode: DependencyNode = {
    id: 'react@18.2.0',
    name: 'react',
    version: '18.2.0',
    tarballUrl: '',
    isDev: false,
    isOptional: false,
    dependencies: new Map(),
    peerDependencies: {},
    parentIds: new Set()
  };

  // Lib requires react >=19
  const libNode: DependencyNode = {
    id: 'next-gen-ui@1.0.0',
    name: 'next-gen-ui',
    version: '1.0.0',
    tarballUrl: '',
    isDev: false,
    isOptional: false,
    dependencies: new Map(),
    peerDependencies: {
      react: '>=19.0.0'
    },
    parentIds: new Set()
  };

  graph.addNode(reactNode);
  graph.addNode(libNode);
  graph.rootDependencies.set('react', 'react@18.2.0');
  graph.rootDependencies.set('next-gen-ui', 'next-gen-ui@1.0.0');

  const result = PeerEngine.validate(graph);
  assert.equal(result.valid, false);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].code, 'ERR_PEER_CONFLICT');
  assert.equal(result.conflicts[0].packageName, 'react');
});

test('PeerEngine allows satisfied peer dependencies', () => {
  const graph = new DependencyGraph();

  const reactNode: DependencyNode = {
    id: 'react@19.0.0',
    name: 'react',
    version: '19.0.0',
    tarballUrl: '',
    isDev: false,
    isOptional: false,
    dependencies: new Map(),
    peerDependencies: {},
    parentIds: new Set()
  };

  const libNode: DependencyNode = {
    id: 'next-gen-ui@1.0.0',
    name: 'next-gen-ui',
    version: '1.0.0',
    tarballUrl: '',
    isDev: false,
    isOptional: false,
    dependencies: new Map(),
    peerDependencies: {
      react: '>=19.0.0'
    },
    parentIds: new Set()
  };

  graph.addNode(reactNode);
  graph.addNode(libNode);
  graph.rootDependencies.set('react', 'react@19.0.0');
  graph.rootDependencies.set('next-gen-ui', 'next-gen-ui@1.0.0');

  const result = PeerEngine.validate(graph);
  assert.equal(result.valid, true);
  assert.equal(result.conflicts.length, 0);
});

test('PeerEngine treats optional peers as non-fatal warnings', () => {
  const graph = new DependencyGraph();

  const libNode: DependencyNode = {
    id: 'tool@1.0.0',
    name: 'tool',
    version: '1.0.0',
    tarballUrl: '',
    isDev: false,
    isOptional: false,
    dependencies: new Map(),
    peerDependencies: {
      optionalPlugin: '^2.0.0'
    },
    peerDependenciesMeta: {
      optionalPlugin: { optional: true }
    },
    parentIds: new Set()
  };

  graph.addNode(libNode);
  graph.rootDependencies.set('tool', 'tool@1.0.0');

  const result = PeerEngine.validate(graph);
  assert.equal(result.valid, true);
  assert.equal(result.conflicts.length, 0);
});
