import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { STORE_DIR, safePackageName } from '../config/index.js';
import type { ResolvedPackage } from '../registry.js';
import { FetchManager } from '../fetch/index.js';
import { FileLock } from './lock.js';
import { runGarbageCollection, registerProject } from './gc.js';

export * from './lock.js';
export * from './gc.js';

export interface StoredPackageInfo {
  name: string;
  versions: string[];
  totalSizeBytes: number;
}

export function getPackageStoreDir(name: string, version: string): string {
  const safeName = safePackageName(name);
  return path.join(STORE_DIR, safeName, version);
}

export function isPackageInStore(name: string, version: string): boolean {
  const dir = getPackageStoreDir(name, version);
  const pkgJsonPath = path.join(dir, 'package.json');
  return fs.existsSync(dir) && fs.existsSync(pkgJsonPath);
}

export async function extractToStore(pkg: ResolvedPackage, tarballPath: string): Promise<string> {
  const targetDir = getPackageStoreDir(pkg.name, pkg.version);

  if (isPackageInStore(pkg.name, pkg.version)) {
    return targetDir;
  }

  const lockPath = `${targetDir}.lock`;
  const parentDir = path.dirname(targetDir);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  // Cross-process file lock ensures atomic extraction with no concurrency races
  return FileLock.withLock(lockPath, async () => {
    if (isPackageInStore(pkg.name, pkg.version)) {
      return targetDir;
    }

    const tempDir = `${targetDir}.extracting-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      // Safe tar extraction guarding against Zip-Slip path traversal
      await FetchManager.safeExtractTar(tarballPath, tempDir);

      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }

      fs.renameSync(tempDir, targetDir);
      linkToGlobalNodeModules(pkg.name, targetDir);
      runLifecycleScripts(targetDir);
      return targetDir;
    } catch (err) {
      if (fs.existsSync(tempDir)) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
      throw err;
    }
  });
}

export function runLifecycleScripts(storePackageDir: string, ignoreScripts: boolean = false): void {
  if (ignoreScripts) return;
  const pkgJsonPath = path.join(storePackageDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    const script = pkg.scripts?.install || pkg.scripts?.postinstall;
    if (!script) return;

    execSync(script, {
      cwd: storePackageDir,
      stdio: 'ignore',
      timeout: 30000,
      env: {
        ...process.env,
        PATH: `${path.join(storePackageDir, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH}`
      }
    });
  } catch {
    // Failures in optional compile scripts should not crash package installation
  }
}

export function linkToGlobalNodeModules(packageName: string, storePackageDir: string): void {
  const globalNm = path.join(STORE_DIR, '..', 'node_modules');
  if (!fs.existsSync(globalNm)) {
    fs.mkdirSync(globalNm, { recursive: true });
  }

  let targetLink: string;
  if (packageName.startsWith('@')) {
    const [scope, pkgName] = packageName.split('/');
    const scopeDir = path.join(globalNm, scope);
    if (!fs.existsSync(scopeDir)) {
      fs.mkdirSync(scopeDir, { recursive: true });
    }
    targetLink = path.join(scopeDir, pkgName);
  } else {
    targetLink = path.join(globalNm, packageName);
  }

  if (!fs.existsSync(targetLink)) {
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    try {
      fs.symlinkSync(storePackageDir, targetLink, linkType);
    } catch {}
  }
}

export function linkDependencyIntoStorePackage(
  storePackageDir: string,
  depName: string,
  depStoreDir: string
): void {
  const nmDir = path.join(storePackageDir, 'node_modules');
  if (!fs.existsSync(nmDir)) {
    fs.mkdirSync(nmDir, { recursive: true });
  }

  let targetLink: string;
  if (depName.startsWith('@')) {
    const [scope, pkgName] = depName.split('/');
    const scopeDir = path.join(nmDir, scope);
    if (!fs.existsSync(scopeDir)) {
      fs.mkdirSync(scopeDir, { recursive: true });
    }
    targetLink = path.join(scopeDir, pkgName);
  } else {
    targetLink = path.join(nmDir, depName);
  }

  if (!fs.existsSync(targetLink)) {
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    try {
      fs.symlinkSync(depStoreDir, targetLink, linkType);
    } catch {}
  }
}

function getDirectorySize(dirPath: string): number {
  let size = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += getDirectorySize(fullPath);
      } else if (entry.isFile()) {
        try {
          const stats = fs.statSync(fullPath);
          size += stats.size;
        } catch {}
      }
    }
  } catch {}
  return size;
}

export function listStore(): StoredPackageInfo[] {
  if (!fs.existsSync(STORE_DIR)) return [];

  const packages: StoredPackageInfo[] = [];
  const entries = fs.readdirSync(STORE_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const safeName = entry.name;
    const realName = safeName.replace('__', '/');
    const pkgDir = path.join(STORE_DIR, safeName);
    const versionDirs = fs.readdirSync(pkgDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    if (versionDirs.length > 0) {
      const totalSizeBytes = getDirectorySize(pkgDir);
      packages.push({
        name: realName,
        versions: versionDirs,
        totalSizeBytes
      });
    }
  }

  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

export function clearStore(): { removedCount: number } {
  if (!fs.existsSync(STORE_DIR)) return { removedCount: 0 };
  const entries = fs.readdirSync(STORE_DIR);
  for (const entry of entries) {
    fs.rmSync(path.join(STORE_DIR, entry), { recursive: true, force: true });
  }
  return { removedCount: entries.length };
}
