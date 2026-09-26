import test from 'node:test';
import assert from 'node:assert/strict';
import { DependencyGraph, type DependencyNode } from '../src/graph/index.js';
import { createLockfileFromGraph } from '../src/lockfile/index.js';

test('createLockfileFromGraph serializes graph deterministically', () => {
  const graph = new DependencyGraph();

  const nodeB: DependencyNode = {
    id: 'zod@3.22.4',
    name: 'zod',
    version: '3.22.4',
    tarballUrl: 'https://registry.npmjs.org/zod/-/zod-3.22.4.tgz',
    integrity: 'sha512-test-hash',
    isDev: false,
    isOptional: false,
    dependencies: new Map(),
    peerDependencies: {},
    parentIds: new Set(['express@4.19.2'])
  };

  const nodeA: DependencyNode = {
    id: 'express@4.19.2',
    name: 'express',
    version: '4.19.2',
    tarballUrl: 'https://registry.npmjs.org/express/-/express-4.19.2.tgz',
    integrity: 'sha512-express-hash',
    isDev: false,
    isOptional: false,
    dependencies: new Map([['zod', 'zod@3.22.4']]),
    peerDependencies: {},
    parentIds: new Set()
  };

  graph.addNode(nodeA);
  graph.addNode(nodeB);
  graph.rootDependencies.set('express', 'express@4.19.2');

  const lockfile = createLockfileFromGraph(graph);
  assert.equal(lockfile.lockfileVersion, 2);
  assert.ok(lockfile.packages['express@4.19.2']);
  assert.ok(lockfile.packages['zod@3.22.4']);

  assert.equal(lockfile.packages['express@4.19.2'].version, '4.19.2');
  assert.deepEqual(lockfile.packages['express@4.19.2'].dependencies, { zod: '3.22.4' });
});
