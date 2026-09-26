import fs from 'node:fs';
import path from 'node:path';
import { LINKPM_HOME, STORE_DIR, safePackageName } from '../config/index.js';
import { LOCKFILE_NAME, readLockfile } from '../lockfile/index.js';

export const PROJECTS_FILE = path.join(LINKPM_HOME, 'projects.json');

export interface GCOptions {
  dryRun?: boolean;
}

export interface GCResult {
  activeProjects: string[];
  totalStorePackages: number;
  prunedCount: number;
  prunedPackages: string[];
  freedBytes: number;
}

export function registerProject(projectRoot: string): void {
  try {
    const list = getRegisteredProjects();
    const resolved = path.resolve(projectRoot);
    if (!list.includes(resolved)) {
      list.push(resolved);
      fs.writeFileSync(PROJECTS_FILE, JSON.stringify(list, null, 2), 'utf-8');
    }
  } catch {}
}

export function getRegisteredProjects(): string[] {
  try {
    if (!fs.existsSync(PROJECTS_FILE)) return [];
    const raw = fs.readFileSync(PROJECTS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getDirectorySize(dirPath: string): number {
  let size = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += getDirectorySize(full);
      } else if (entry.isFile()) {
        try { size += fs.statSync(full).size; } catch {}
      }
    }
  } catch {}
  return size;
}

export function runGarbageCollection(options: GCOptions = {}): GCResult {
  const registered = getRegisteredProjects();
  const validProjects = registered.filter(p => fs.existsSync(p));

  // Update projects.json with still-existing projects
  try {
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(validProjects, null, 2), 'utf-8');
  } catch {}

  // Collect all package@version keys referenced across all active projects
  const referencedKeys = new Set<string>();

  for (const proj of validProjects) {
    const lock = readLockfile(proj);
    if (lock) {
      for (const key of Object.keys(lock.packages)) {
        referencedKeys.add(key);
      }
    }
  }

  const prunedPackages: string[] = [];
  let freedBytes = 0;
  let totalStorePackages = 0;

  if (fs.existsSync(STORE_DIR)) {
    const pkgEntries = fs.readdirSync(STORE_DIR, { withFileTypes: true });

    for (const entry of pkgEntries) {
      if (!entry.isDirectory()) continue;
      const safeName = entry.name;
      const realName = safeName.replace(/__/g, '/');
      const pkgDir = path.join(STORE_DIR, safeName);
      const versionDirs = fs.readdirSync(pkgDir, { withFileTypes: true }).filter(d => d.isDirectory());

      totalStorePackages += versionDirs.length;

      for (const vDir of versionDirs) {
        const version = vDir.name;
        const key = `${realName}@${version}`;

        // If not referenced by any project, prune it!
        if (!referencedKeys.has(key)) {
          const dirToPrune = path.join(pkgDir, version);
          const size = getDirectorySize(dirToPrune);
          freedBytes += size;
          prunedPackages.push(key);

          if (!options.dryRun) {
            try {
              fs.rmSync(dirToPrune, { recursive: true, force: true });
            } catch {}
          }
        }
      }

      // If package directory is now empty, clean it up
      try {
        if (!options.dryRun && fs.readdirSync(pkgDir).length === 0) {
          fs.rmdirSync(pkgDir);
        }
      } catch {}
    }
  }

  return {
    activeProjects: validProjects,
    totalStorePackages,
    prunedCount: prunedPackages.length,
    prunedPackages,
    freedBytes
  };
}
