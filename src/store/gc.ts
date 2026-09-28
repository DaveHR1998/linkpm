import fs from 'node:fs';
import path from 'node:path';
import { LINKPM_HOME, getStoreDir, safePackageName } from '../config/index.js';
import { LOCKFILE_NAME, readLockfile } from '../lockfile/index.js';

export const PROJECTS_FILE = path.join(LINKPM_HOME, 'projects.json');
export const DEFAULT_RETENTION_DAYS = 30;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ProjectRecord {
  path: string;
  lastSeen: number;
  lockfilePackages?: string[];
}

export interface GCOptions {
  dryRun?: boolean;
  retentionDays?: number;
  force?: boolean;
}

export interface GCResult {
  activeProjects: string[];
  unmountedProjects: string[];
  totalStorePackages: number;
  prunedCount: number;
  prunedPackages: string[];
  retainedGraceCount: number;
  retainedGracePackages: string[];
  freedBytes: number;
  retentionDays: number;
}

export function registerProject(projectRoot: string): void {
  try {
    const records = getRegisteredProjectRecords();
    const resolved = path.resolve(projectRoot);
    const existing = records.find(r => r.path === resolved);

    // Snapshot lockfile packages if lockfile exists
    let lockfilePackages: string[] | undefined;
    const lock = readLockfile(resolved);
    if (lock) {
      lockfilePackages = Object.keys(lock.packages);
    }

    if (existing) {
      existing.lastSeen = Date.now();
      if (lockfilePackages) {
        existing.lockfilePackages = lockfilePackages;
      }
    } else {
      records.push({
        path: resolved,
        lastSeen: Date.now(),
        lockfilePackages
      });
    }

    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(records, null, 2), 'utf-8');
  } catch {}
}

export function getRegisteredProjectRecords(): ProjectRecord[] {
  try {
    if (!fs.existsSync(PROJECTS_FILE)) return [];
    const raw = fs.readFileSync(PROJECTS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(item => {
      if (typeof item === 'string') {
        return { path: item, lastSeen: Date.now() };
      }
      return item;
    });
  } catch {
    return [];
  }
}

export function getRegisteredProjects(): string[] {
  return getRegisteredProjectRecords().map(r => r.path);
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
  const retentionDays = options.force
    ? 0
    : (typeof options.retentionDays === 'number' ? options.retentionDays : DEFAULT_RETENTION_DAYS);
  const retentionMs = retentionDays * MS_PER_DAY;
  const now = Date.now();

  const records = getRegisteredProjectRecords();
  const updatedRecords: ProjectRecord[] = [];
  const activeProjects: string[] = [];
  const unmountedProjects: string[] = [];
  const referencedKeys = new Set<string>();

  for (const record of records) {
    const exists = fs.existsSync(record.path);

    if (exists) {
      activeProjects.push(record.path);
      record.lastSeen = now;
      const lock = readLockfile(record.path);
      if (lock) {
        const pkgs = Object.keys(lock.packages);
        record.lockfilePackages = pkgs;
        for (const k of pkgs) {
          referencedKeys.add(k);
        }
      } else if (record.lockfilePackages) {
        for (const k of record.lockfilePackages) {
          referencedKeys.add(k);
        }
      }
      updatedRecords.push(record);
    } else {
      // Unmounted drive, disconnected USB/SSD, or temporarily inaccessible path
      const ageMs = now - (record.lastSeen || 0);
      const isWithinRetention = retentionDays > 0 && ageMs < retentionMs;

      if (isWithinRetention) {
        // Retain unmounted project in grace period!
        unmountedProjects.push(record.path);
        // Protect packages referenced in its last known lockfile snapshot!
        if (record.lockfilePackages) {
          for (const k of record.lockfilePackages) {
            referencedKeys.add(k);
          }
        }
        updatedRecords.push(record);
      } else {
        // Exceeded retention period: safely drop the abandoned project path
      }
    }
  }

  // Update projects.json with active and grace-period-retained projects
  try {
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(updatedRecords, null, 2), 'utf-8');
  } catch {}

  const prunedPackages: string[] = [];
  const retainedGracePackages: string[] = [];
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
        const dirPath = path.join(pkgDir, version);

        if (!referencedKeys.has(key)) {
          // Check package age against retention grace period
          let packageAgeMs = Infinity;
          try {
            const stat = fs.statSync(dirPath);
            const lastActive = stat.mtimeMs || stat.ctimeMs || 0;
            packageAgeMs = now - lastActive;
          } catch {}

          if (retentionDays > 0 && packageAgeMs < retentionMs) {
            // Protected by 30-day retention grace period!
            retainedGracePackages.push(key);
          } else {
            // Expired past grace period or force=true: safe to prune!
            const size = getDirectorySize(dirPath);
            freedBytes += size;
            prunedPackages.push(key);

            if (!options.dryRun) {
              safeRemoveStorePackage(dirPath);
            }
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
    activeProjects,
    unmountedProjects,
    totalStorePackages,
    prunedCount: prunedPackages.length,
    prunedPackages,
    retainedGraceCount: retainedGracePackages.length,
    retainedGracePackages,
    freedBytes,
    retentionDays
  };
}
