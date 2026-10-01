import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import type { DependencyGraph, DependencyNode } from '../graph/index.js';
import { LinkPMError } from '../utils/errors.js';

export interface LockfilePackageV2 {
  version: string;
  resolved: string;
  integrity?: string;
  isDev?: boolean;
  isOptional?: boolean;
  dependencies?: Record<string, string>; // depName -> version
  peerDependencies?: Record<string, string>;
}

export interface LockfileV2 {
  lockfileVersion: 2;
  packages: Record<string, LockfilePackageV2>;
}

export const LOCKFILE_NAME = 'linkpm-lock.json';

export function getLockfilePath(projectRoot: string): string {
  return path.join(projectRoot, LOCKFILE_NAME);
}

export function readLockfile(projectRoot: string): LockfileV2 | null {
  const filePath = getLockfilePath(projectRoot);
  if (!fs.existsSync(filePath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (raw.lockfileVersion === 1) {
      // Upgrade v1 to v2 in memory
      const upgraded: LockfileV2 = {
        lockfileVersion: 2,
        packages: raw.packages || {}
      };
      return upgraded;
    }
    return raw as LockfileV2;
  } catch {
    return null;
  }
}

export function writeLockfile(projectRoot: string, lockfile: LockfileV2): void {
  const filePath = getLockfilePath(projectRoot);

  // Alphabetically sort package entries for deterministic output
  const sortedPackages: Record<string, LockfilePackageV2> = {};
  for (const key of Object.keys(lockfile.packages).sort()) {
    const entry = lockfile.packages[key];
    const sortedDeps: Record<string, string> = {};
    if (entry.dependencies) {
      for (const d of Object.keys(entry.dependencies).sort()) {
        sortedDeps[d] = entry.dependencies[d];
      }
    }

    sortedPackages[key] = {
      version: entry.version,
      resolved: entry.resolved,
      integrity: entry.integrity,
      isDev: entry.isDev,
      isOptional: entry.isOptional,
      dependencies: Object.keys(sortedDeps).length > 0 ? sortedDeps : undefined,
      peerDependencies: entry.peerDependencies && Object.keys(entry.peerDependencies).length > 0 ? entry.peerDependencies : undefined
    };
  }

  const output: LockfileV2 = {
    lockfileVersion: 2,
    packages: sortedPackages
  };

  fs.writeFileSync(filePath, JSON.stringify(output, null, 2) + '\n', 'utf-8');

  // Automatic Lockfile Mirroring: write 100% compliant package-lock.json (v3) for Vercel, Netlify, Render & Dependabot
  try {
    syncNpmPackageLock(projectRoot, output);
  } catch {}
}

export function syncNpmPackageLock(projectRoot: string, lockfile: LockfileV2): void {
  const npmLockPath = path.join(projectRoot, 'package-lock.json');
  const pkgJsonPath = path.join(projectRoot, 'package.json');

  let pkgJson: any = {};
  if (fs.existsSync(pkgJsonPath)) {
    try {
      pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    } catch {}
  }

  const npmPackages: Record<string, any> = {
    '': {
      name: pkgJson.name || 'project',
      version: pkgJson.version || '1.0.0',
      dependencies: pkgJson.dependencies ? { ...pkgJson.dependencies } : undefined,
      devDependencies: pkgJson.devDependencies ? { ...pkgJson.devDependencies } : undefined,
      peerDependencies: pkgJson.peerDependencies ? { ...pkgJson.peerDependencies } : undefined
    }
  };

  for (const [key, entry] of Object.entries(lockfile.packages)) {
    const atIdx = key.lastIndexOf('@');
    const name = atIdx > 0 ? key.slice(0, atIdx) : key;
    const nodeModulesKey = `node_modules/${name}`;

    npmPackages[nodeModulesKey] = {
      version: entry.version,
      resolved: entry.resolved,
      integrity: entry.integrity,
      dev: entry.isDev ? true : undefined,
      optional: entry.isOptional ? true : undefined,
      dependencies: entry.dependencies && Object.keys(entry.dependencies).length > 0 ? entry.dependencies : undefined,
      peerDependencies: entry.peerDependencies && Object.keys(entry.peerDependencies).length > 0 ? entry.peerDependencies : undefined
    };
  }

  const npmLock = {
    name: pkgJson.name || 'project',
    version: pkgJson.version || '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: npmPackages
  };

  fs.writeFileSync(npmLockPath, JSON.stringify(npmLock, null, 2) + '\n', 'utf-8');
}

export function updateLockfile(
  projectRoot: string,
  entries: Array<{
    name: string;
    version: string;
    tarballUrl: string;
    integrity?: string;
    isDev?: boolean;
    dependencies?: Record<string, string>;
  }>
): void {
  const existing = readLockfile(projectRoot) || {
    lockfileVersion: 2,
    packages: {}
  };

  for (const entry of entries) {
    const key = `${entry.name}@${entry.version}`;
    const prior = existing.packages[key];
    // A package reachable from production must never be marked dev-only
    // (mirrors npm hoisting semantics for shared transitive deps).
    const isDev = prior && prior.isDev === false ? false : entry.isDev;
    existing.packages[key] = {
      version: entry.version,
      resolved: entry.tarballUrl || prior?.resolved || '',
      integrity: entry.integrity || prior?.integrity,
      isDev,
      dependencies: entry.dependencies
    };
  }

  writeLockfile(projectRoot, existing);
}

export function removeLockfileEntries(projectRoot: string, packageNames: string[]): void {
  const existing = readLockfile(projectRoot);
  if (!existing) return;

  for (const key of Object.keys(existing.packages)) {
    for (const pkg of packageNames) {
      if (key.startsWith(`${pkg}@`)) {
        delete existing.packages[key];
      }
    }
  }

  writeLockfile(projectRoot, existing);
}

export function createLockfileFromGraph(graph: DependencyGraph): LockfileV2 {
  const packages: Record<string, LockfilePackageV2> = {};

  for (const node of graph.nodes.values()) {
    const key = `${node.name}@${node.version}`;
    const depsRecord: Record<string, string> = {};

    for (const [depName, childId] of node.dependencies.entries()) {
      const child = graph.getNode(childId);
      if (child) {
        depsRecord[depName] = child.version;
      }
    }

    packages[key] = {
      version: node.version,
      resolved: node.tarballUrl,
      integrity: node.integrity,
      isDev: node.isDev,
      isOptional: node.isOptional,
      dependencies: Object.keys(depsRecord).length > 0 ? depsRecord : undefined,
      peerDependencies: Object.keys(node.peerDependencies).length > 0 ? node.peerDependencies : undefined
    };
  }

  return {
    lockfileVersion: 2,
    packages
  };
}

export function verifyLockfileParity(
  projectRoot: string,
  pkgJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
): { valid: boolean; missing: string[] } {
  const result = verifyLockfileIntegrity(projectRoot, pkgJson);
  return {
    valid: result.valid,
    missing: result.errors
  };
}

export function verifyLockfileIntegrity(
  projectRoot: string,
  customPkgJson?: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
): { valid: boolean; errors: string[] } {
  const lockfile = readLockfile(projectRoot);
  if (!lockfile) {
    throw new LinkPMError(`No ${LOCKFILE_NAME} found in ${projectRoot}`, {
      code: 'ERR_LOCKFILE_MISMATCH',
      hint: 'Run "linkpm install" first to generate a deterministic lockfile before running in CI.'
    });
  }

  let pkgJson = customPkgJson;
  if (!pkgJson) {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      } catch {}
    }
  }

  const errors: string[] = [];
  const allReqs = { ...(pkgJson?.dependencies || {}), ...(pkgJson?.devDependencies || {}) };

  for (const [name, range] of Object.entries(allReqs)) {
    // If range is catalog: or local, check key presence
    if (range.startsWith('catalog:')) {
      const found = Object.keys(lockfile.packages).some(key => key.startsWith(`${name}@`));
      if (!found) {
        errors.push(`Missing locked version for catalog dependency "${name}"`);
      }
      continue;
    }

    if (range.startsWith('workspace:') || range.startsWith('file:') || range.startsWith('link:')) {
      continue;
    }

    // Find matching entry in lockfile
    const matched = Object.keys(lockfile.packages).some(key => {
      if (key.startsWith(`${name}@`)) {
        const ver = key.slice(name.length + 1);
        return semver.satisfies(ver, range, { includePrerelease: true }) || range === 'latest';
      }
      return false;
    });

    if (!matched) {
      errors.push(`Dependency "${name}@${range}" is not satisfied by any version in ${LOCKFILE_NAME}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Imports an external standard lockfile (e.g. package-lock.json from a Dependabot PR)
 * and synchronizes linkpm-lock.json and package-lock.json in lockstep.
 */
export function importLockfile(
  projectRoot: string,
  sourceLockfilePath?: string
): { importedCount: number; lockfilePath: string } {
  const filePath = sourceLockfilePath
    ? path.resolve(projectRoot, sourceLockfilePath)
    : path.join(projectRoot, 'package-lock.json');

  if (!fs.existsSync(filePath)) {
    throw new LinkPMError(`Lockfile to import not found at ${filePath}`, {
      code: 'ERR_LOCKFILE_MISMATCH',
      hint: 'Specify a valid package-lock.json path. Example: linkpm import-lock package-lock.json'
    });
  }

  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err: any) {
    throw new LinkPMError(`Failed to parse lockfile at ${filePath}: ${err.message}`, {
      code: 'ERR_LOCKFILE_MISMATCH'
    });
  }

  const currentLock: LockfileV2 = readLockfile(projectRoot) || { lockfileVersion: 2, packages: {} };
  let importedCount = 0;

  // Handle npm v2/v3 package-lock.json
  if (raw.packages && typeof raw.packages === 'object') {
    for (const [key, pkgInfo] of Object.entries<any>(raw.packages)) {
      if (!key || key === '') continue; // Skip root project
      const name = key.startsWith('node_modules/') ? key.slice('node_modules/'.length) : key;
      if (!pkgInfo.version) continue;

      const lockKey = `${name}@${pkgInfo.version}`;
      currentLock.packages[lockKey] = {
        version: pkgInfo.version,
        resolved: pkgInfo.resolved || '',
        integrity: pkgInfo.integrity,
        isDev: Boolean(pkgInfo.dev),
        isOptional: Boolean(pkgInfo.optional),
        dependencies: pkgInfo.dependencies,
        peerDependencies: pkgInfo.peerDependencies
      };
      importedCount++;
    }
  } else if (raw.dependencies && typeof raw.dependencies === 'object') {
    // Handle npm v1 package-lock.json
    for (const [name, pkgInfo] of Object.entries<any>(raw.dependencies)) {
      if (!pkgInfo.version) continue;
      const lockKey = `${name}@${pkgInfo.version}`;
      currentLock.packages[lockKey] = {
        version: pkgInfo.version,
        resolved: pkgInfo.resolved || '',
        integrity: pkgInfo.integrity,
        isDev: Boolean(pkgInfo.dev),
        dependencies: pkgInfo.requires
      };
      importedCount++;
    }
  }

  writeLockfile(projectRoot, currentLock);

  return {
    importedCount,
    lockfilePath: filePath
  };
}

