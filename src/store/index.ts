import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { getStoreDir, safePackageName } from '../config/index.js';
import type { ResolvedPackage } from '../registry.js';
import { FetchManager } from '../fetch/index.js';
import { FileLock } from './lock.js';
import { runGarbageCollection, registerProject } from './gc.js';
import { applyPatchToDirectory } from '../patches/index.js';

export * from './lock.js';
export * from './gc.js';

export interface StoredPackageInfo {
  name: string;
  versions: string[];
  totalSizeBytes: number;
}

export interface ExtractOptions {
  ignoreScripts?: boolean;
  onlyBuiltDependencies?: string[];
  allowAllScripts?: boolean;
  patchFile?: string;
}

export function computePatchHash(patchContent: string): string {
  return crypto.createHash('sha256').update(patchContent.trim()).digest('hex').slice(0, 8);
}

export function getPackageStoreDir(name: string, version: string): string {
  const safeName = safePackageName(name);
  return path.join(getStoreDir(), safeName, version);
}

export function isPackageInStore(name: string, version: string): boolean {
  const dir = getPackageStoreDir(name, version);
  const pkgJsonPath = path.join(dir, 'package.json');
  return fs.existsSync(dir) && fs.existsSync(pkgJsonPath);
}

export async function extractToStore(
  pkg: ResolvedPackage,
  tarballPath: string,
  options: ExtractOptions = {}
): Promise<string> {
  let effectiveVersion = pkg.version;
  let patchContent: string | null = null;

  if (options.patchFile && fs.existsSync(options.patchFile)) {
    try {
      patchContent = fs.readFileSync(options.patchFile, 'utf-8');
      const patchHash = computePatchHash(patchContent);
      effectiveVersion = `${pkg.version}_patch_${patchHash}`;
    } catch {}
  }

  const targetDir = getPackageStoreDir(pkg.name, effectiveVersion);

  if (isPackageInStore(pkg.name, effectiveVersion)) {
    return targetDir;
  }

  const lockPath = `${targetDir}.lock`;
  const parentDir = path.dirname(targetDir);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  // Cross-process file lock ensures atomic extraction with no concurrency races
  return FileLock.withLock(lockPath, async () => {
    if (isPackageInStore(pkg.name, effectiveVersion)) {
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

      // Apply patch if requested
      if (patchContent) {
        applyPatchToDirectory(tempDir, patchContent);
      }

      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }

      fs.renameSync(tempDir, targetDir);
      linkToGlobalNodeModules(pkg.name, targetDir);
      runLifecycleScripts(targetDir, options);
      return targetDir;
    } catch (err) {
      if (fs.existsSync(tempDir)) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
      throw err;
    }
  });
}

export function runLifecycleScripts(
  storePackageDir: string,
  options: ExtractOptions | boolean = {}
): void {
  const opts: ExtractOptions = typeof options === 'boolean' ? { ignoreScripts: options } : options;
  if (opts.ignoreScripts) return;

  const pkgJsonPath = path.join(storePackageDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    const script = pkg.scripts?.install || pkg.scripts?.postinstall;
    if (!script) return;

    // Supply-chain gating: check onlyBuiltDependencies
    if (opts.onlyBuiltDependencies && opts.onlyBuiltDependencies.length > 0) {
      const allowed = opts.onlyBuiltDependencies;
      const baseName = pkg.name.startsWith('@') ? pkg.name.split('/')[1] : pkg.name;
      if (!allowed.includes(pkg.name) && !allowed.includes(baseName)) {
        // Block untrusted lifecycle script
        return;
      }
    } else if (!opts.allowAllScripts) {
      // Default safe whitelist for well-known build tools
      const SAFE_BUILT_DEPENDENCIES = new Set([
        'esbuild', '@swc/core', 'sharp', 'prisma', '@prisma/client', 'core-js', 'sqlite3', 'canvas', 'node-gyp'
      ]);
      const baseName = pkg.name.startsWith('@') ? pkg.name.split('/')[1] : pkg.name;
      if (!SAFE_BUILT_DEPENDENCIES.has(pkg.name) && !SAFE_BUILT_DEPENDENCIES.has(baseName)) {
        // Skip untrusted build script
        return;
      }
    }

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
  const globalNm = path.join(getStoreDir(), '..', 'node_modules');
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
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += getDirectorySize(fullPath, visited);
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
  const store = getStoreDir();
  if (!fs.existsSync(store)) return [];

  const packages: StoredPackageInfo[] = [];
  const entries = fs.readdirSync(store, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const safeName = entry.name;
    const realName = safeName.replace(/__/g, '/');
    const pkgDir = path.join(store, safeName);
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
  const store = getStoreDir();
  if (!fs.existsSync(store)) return { removedCount: 0 };
  const entries = fs.readdirSync(store);
  for (const entry of entries) {
    fs.rmSync(path.join(store, entry), { recursive: true, force: true });
  }
  return { removedCount: entries.length };
}
