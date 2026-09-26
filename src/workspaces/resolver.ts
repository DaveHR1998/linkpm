import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import { WorkspacePackage } from './discovery.js';
import { linkPackage } from '../linker.js';

export interface WorkspaceLinkResult {
  sourcePackage: string;
  targetPackage: string;
  linkPath: string;
}

export function isWorkspaceSpec(spec: string): boolean {
  return spec.startsWith('workspace:');
}

export function matchWorkspaceDependency(
  depName: string,
  depRange: string,
  workspaceMap: Map<string, WorkspacePackage>
): WorkspacePackage | null {
  const target = workspaceMap.get(depName);
  if (!target) return null;

  if (isWorkspaceSpec(depRange)) {
    const rawRange = depRange.replace('workspace:', '').trim();
    if (rawRange === '*' || rawRange === '^' || rawRange === '~' || rawRange === '') {
      return target;
    }
    // Check semver if specified like workspace:^1.0.0
    if (semver.validRange(rawRange) && semver.satisfies(target.version, rawRange)) {
      return target;
    }
    return target;
  }

  // If standard range and version satisfies
  if (semver.validRange(depRange) && semver.satisfies(target.version, depRange)) {
    return target;
  }

  return null;
}

export function linkWorkspaceDependencies(packages: WorkspacePackage[]): WorkspaceLinkResult[] {
  const workspaceMap = new Map<string, WorkspacePackage>();
  for (const pkg of packages) {
    workspaceMap.set(pkg.name, pkg);
  }

  const results: WorkspaceLinkResult[] = [];

  for (const pkg of packages) {
    const allDeps: Record<string, string> = {
      ...(pkg.pkgJson.dependencies || {}),
      ...(pkg.pkgJson.devDependencies || {})
    };

    for (const [depName, depRange] of Object.entries(allDeps)) {
      const targetPkg = matchWorkspaceDependency(depName, depRange, workspaceMap);
      if (targetPkg && targetPkg.directory !== pkg.directory) {
        linkPackage(pkg.directory, targetPkg.name, targetPkg.directory);
        results.push({
          sourcePackage: pkg.name,
          targetPackage: targetPkg.name,
          linkPath: path.join(pkg.directory, 'node_modules', targetPkg.name)
        });
      }
    }
  }

  return results;
}
