import fs from 'node:fs';
import path from 'node:path';
import { LINKPM_HOME, getStoreDir, safePackageName } from '../config/index.js';
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

function getDirectorySize(dirPath: string, visited: Set<string> = new Set()): number {
  let size = 0;
  try {
    let realPath = dirPath;
    try { realPath = fs.realpathSync(dirPath); } catch {}
    if (visited.has(realPath)) return 0;
    visited.add(realPath);

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += getDirectorySize(full, visited);
      } else if (entry.isFile()) {
        try { size += fs.statSync(full).size; } catch {}
      }
    }
  } catch {}
  return size;
}

function makeDirWritable(dirPath: string): void {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        makeDirWritable(full);
      } else if (entry.isFile()) {
        try { fs.chmodSync(full, 0o666); } catch {}
      }
    }
  } catch {}
}

function safeRemoveStorePackage(dirPath: string): void {
  try {
    // If it contains internal node_modules with junctions, unmount them first
    const internalNm = path.join(dirPath, 'node_modules');
    if (fs.existsSync(internalNm)) {
      try {
        const nmEntries = fs.readdirSync(internalNm, { withFileTypes: true });
        for (const nmEntry of nmEntries) {
          const nmItemPath = path.join(internalNm, nmEntry.name);
          if (nmEntry.isSymbolicLink()) {
            try { fs.unlinkSync(nmItemPath); } catch {}
          } else if (process.platform === 'win32') {
            try { fs.rmdirSync(nmItemPath); } catch {}
          }
        }
      } catch {}
    }
    // Ensure read-only files on Windows can be cleanly deleted
    makeDirWritable(dirPath);
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {}
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

  const storeDir = getStoreDir();
  if (fs.existsSync(storeDir)) {
    const pkgEntries = fs.readdirSync(storeDir, { withFileTypes: true });

    for (const entry of pkgEntries) {
      if (!entry.isDirectory()) continue;
      const safeName = entry.name;
      const realName = safeName.replace(/__/g, '/');
      const pkgDir = path.join(storeDir, safeName);
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
            safeRemoveStorePackage(dirToPrune);
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
