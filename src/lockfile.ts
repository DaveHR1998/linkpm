import fs from 'node:fs';
import path from 'node:path';

export interface LockfileEntry {
  version: string;
  resolved: string;
  integrity?: string;
  isDev?: boolean;
  dependencies?: Record<string, string>;
}

export interface Lockfile {
  lockfileVersion: 1;
  packages: Record<string, LockfileEntry>;
}

export const LOCKFILE_NAME = 'linkpm-lock.json';

export function getLockfilePath(projectRoot: string): string {
  return path.join(projectRoot, LOCKFILE_NAME);
}

export function readLockfile(projectRoot: string): Lockfile | null {
  const filePath = getLockfilePath(projectRoot);
  if (!fs.existsSync(filePath)) return null;

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeLockfile(projectRoot: string, lockfile: Lockfile): void {
  const filePath = getLockfilePath(projectRoot);
  // Sort packages alphabetically for stable git diffs
  const sortedPackages: Record<string, LockfileEntry> = {};
  for (const key of Object.keys(lockfile.packages).sort()) {
    sortedPackages[key] = lockfile.packages[key];
  }

  const output: Lockfile = {
    lockfileVersion: 1,
    packages: sortedPackages
  };

  fs.writeFileSync(filePath, JSON.stringify(output, null, 2) + '\n', 'utf-8');
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
    lockfileVersion: 1,
    packages: {}
  };

  for (const entry of entries) {
    const key = `${entry.name}@${entry.version}`;
    existing.packages[key] = {
      version: entry.version,
      resolved: entry.tarballUrl,
      integrity: entry.integrity,
      isDev: entry.isDev,
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
