import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  findWorkspaceRoot,
  parsePnpmWorkspaceYaml,
  discoverWorkspacePackages,
  sortWorkspacePackagesTopologically,
  filterWorkspacePackages,
  matchWorkspaceDependency,
  linkWorkspaceDependencies,
  type WorkspacePackage
} from '../src/workspaces/index.js';

test('parsePnpmWorkspaceYaml parses glob patterns cleanly', () => {
  const tmpDir = path.join(os.tmpdir(), `linkpm-yaml-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const yamlPath = path.join(tmpDir, 'pnpm-workspace.yaml');

  fs.writeFileSync(yamlPath, `
packages:
  - 'packages/*'
  - "apps/*"
  - 'components/**'
`);

  const parsed = parsePnpmWorkspaceYaml(yamlPath);
  assert.deepEqual(parsed.globs, ['packages/*', 'apps/*', 'components/**']);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('discoverWorkspacePackages finds packages matching globs', () => {
  const tmpRoot = path.join(os.tmpdir(), `linkpm-ws-disc-${Date.now()}`);
  const pkgA = path.join(tmpRoot, 'packages', 'pkg-a');
  const pkgB = path.join(tmpRoot, 'packages', 'pkg-b');
  fs.mkdirSync(pkgA, { recursive: true });
  fs.mkdirSync(pkgB, { recursive: true });

  fs.writeFileSync(path.join(pkgA, 'package.json'), JSON.stringify({ name: '@monorepo/pkg-a', version: '1.2.0' }));
  fs.writeFileSync(path.join(pkgB, 'package.json'), JSON.stringify({ name: '@monorepo/pkg-b', version: '2.0.0' }));

  const found = discoverWorkspacePackages(tmpRoot, ['packages/*']);
  assert.equal(found.length, 2);
  assert.equal(found[0].name, '@monorepo/pkg-a');
  assert.equal(found[1].name, '@monorepo/pkg-b');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('sortWorkspacePackagesTopologically orders dependencies before dependants', () => {
  const packages: WorkspacePackage[] = [
    {
      name: 'web-app',
      version: '1.0.0',
      directory: '/monorepo/apps/web',
      manifestPath: '/monorepo/apps/web/package.json',
      pkgJson: {
        name: 'web-app',
        dependencies: { '@monorepo/ui': 'workspace:*' }
      }
    },
    {
      name: '@monorepo/ui',
      version: '1.0.0',
      directory: '/monorepo/packages/ui',
      manifestPath: '/monorepo/packages/ui/package.json',
      pkgJson: {
        name: '@monorepo/ui',
        dependencies: { '@monorepo/utils': '^1.0.0' }
      }
    },
    {
      name: '@monorepo/utils',
      version: '1.0.0',
      directory: '/monorepo/packages/utils',
      manifestPath: '/monorepo/packages/utils/package.json',
      pkgJson: {
        name: '@monorepo/utils',
        dependencies: {}
      }
    }
  ];

  const sorted = sortWorkspacePackagesTopologically(packages);
  const sortedNames = sorted.map(p => p.name);

  assert.deepEqual(sortedNames, ['@monorepo/utils', '@monorepo/ui', 'web-app']);
});

test('filterWorkspacePackages filters by exact name and wildcard pattern', () => {
  const packages: WorkspacePackage[] = [
    { name: 'app-web', version: '1.0', directory: '', manifestPath: '', pkgJson: {} },
    { name: 'app-docs', version: '1.0', directory: '', manifestPath: '', pkgJson: {} },
    { name: 'shared-core', version: '1.0', directory: '', manifestPath: '', pkgJson: {} }
  ];

  const exact = filterWorkspacePackages(packages, 'shared-core');
  assert.equal(exact.length, 1);
  assert.equal(exact[0].name, 'shared-core');

  const wildcard = filterWorkspacePackages(packages, 'app-*');
  assert.equal(wildcard.length, 2);
  assert.deepEqual(wildcard.map(p => p.name), ['app-web', 'app-docs']);
});

test('matchWorkspaceDependency handles workspace:* and semver satisfaction', () => {
  const targetPkg: WorkspacePackage = {
    name: '@scope/tools',
    version: '1.5.0',
    directory: '/tmp/tools',
    manifestPath: '/tmp/tools/package.json',
    pkgJson: {}
  };

  const map = new Map<string, WorkspacePackage>([['@scope/tools', targetPkg]]);

  assert.ok(matchWorkspaceDependency('@scope/tools', 'workspace:*', map));
  assert.ok(matchWorkspaceDependency('@scope/tools', 'workspace:^1.0.0', map));
  assert.ok(matchWorkspaceDependency('@scope/tools', '^1.4.0', map));
  assert.equal(matchWorkspaceDependency('@scope/tools', '^2.0.0', map), null);
  assert.equal(matchWorkspaceDependency('missing-pkg', 'workspace:*', map), null);
});
