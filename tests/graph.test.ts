import test from 'node:test';
import assert from 'node:assert/strict';
import { DependencyGraph, type DependencyNode } from '../src/graph/index.js';

test('DependencyGraph builds DAG and supports topological ordering and why', () => {
  const graph = new DependencyGraph();

  const nodeA: DependencyNode = {
    id: 'pkg-a@1.0.0',
    name: 'pkg-a',
    version: '1.0.0',
    tarballUrl: 'http://example.com/a.tgz',
    isDev: false,
    isOptional: false,
    dependencies: new Map([['pkg-b', 'pkg-b@2.0.0']]),
    peerDependencies: {},
    parentIds: new Set()
  };

  const nodeB: DependencyNode = {
    id: 'pkg-b@2.0.0',
    name: 'pkg-b',
    version: '2.0.0',
    tarballUrl: 'http://example.com/b.tgz',
    isDev: false,
    isOptional: false,
    dependencies: new Map([['pkg-c', 'pkg-c@3.0.0']]),
    peerDependencies: {},
    parentIds: new Set(['pkg-a@1.0.0'])
  };

  const nodeC: DependencyNode = {
    id: 'pkg-c@3.0.0',
    name: 'pkg-c',
    version: '3.0.0',
    tarballUrl: 'http://example.com/c.tgz',
    isDev: false,
    isOptional: false,
    dependencies: new Map(),
    peerDependencies: {},
    parentIds: new Set(['pkg-b@2.0.0'])
  };

  graph.addNode(nodeA);
  graph.addNode(nodeB);
  graph.addNode(nodeC);

  graph.rootDependencies.set('pkg-a', 'pkg-a@1.0.0');

  // 1. Check topological order (dependencies first)
  const order = graph.getTopologicalOrder();
  assert.equal(order.length, 3);
  assert.equal(order[0].name, 'pkg-c');
  assert.equal(order[1].name, 'pkg-b');
  assert.equal(order[2].name, 'pkg-a');

  // 2. Check why
  const paths = graph.why('pkg-c');
  assert.equal(paths.length, 1);
  assert.deepEqual(paths[0], ['(root:dependencies)', 'pkg-a@1.0.0', 'pkg-b@2.0.0', 'pkg-c@3.0.0']);

  // 3. Check tree string contains package names
  const tree = graph.toTreeString();
  assert.ok(tree.includes('pkg-a'));
  assert.ok(tree.includes('pkg-b'));
  assert.ok(tree.includes('pkg-c'));
});
