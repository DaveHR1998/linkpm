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

export function getNativeAbiSuffix(): string {
  return `_abi${process.versions.modules}_${process.platform}_${process.arch}`;
}

export function isNativePackage(nameOrPkg: any, maybePkgJson?: any): boolean {
  let name = '';
  let pkgJson: any = null;

  if (typeof nameOrPkg === 'string') {
    name = nameOrPkg;
    pkgJson = maybePkgJson;
  } else if (nameOrPkg && typeof nameOrPkg === 'object') {
    pkgJson = nameOrPkg;
    name = pkgJson.name || '';
  }

  if (pkgJson) {
    if (pkgJson.gypfile) return true;
    if (pkgJson.binary) return true;
    const scripts = pkgJson.scripts || {};
    const installScript = `${scripts.install || ''} ${scripts.postinstall || ''} ${scripts.preinstall || ''}`;
    if (/node-gyp|prebuild-install|cmake-js|cargo-cp-artifact|neon/i.test(installScript)) {
      return true;
    }
  }
  const KNOWN_NATIVE = new Set([
    'sharp', 'sqlite3', 'better-sqlite3', 'bcrypt', 'canvas', 'fsevents', 're2', 'couchbase', 'sodium-native'
  ]);
  const baseName = name && name.startsWith('@') ? name.split('/')[1] : name;
  return KNOWN_NATIVE.has(name) || KNOWN_NATIVE.has(baseName);
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

  // Native module ABI isolation
  if (isNativePackage(pkg.name)) {
    effectiveVersion = `${effectiveVersion}_${getNativeAbiSuffix()}`;
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
        markStoreDirectoryWritable(targetDir);
        fs.rmSync(targetDir, { recursive: true, force: true });
      }

      fs.renameSync(tempDir, targetDir);
      runLifecycleScripts(targetDir, options);
      // Protect global store from in-place edits and store poisoning
      markStoreDirectoryReadOnly(targetDir);
      return targetDir;
    } catch (err) {
      if (fs.existsSync(tempDir)) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
      throw err;
    }
  });
}

export function markStoreDirectoryReadOnly(dirPath: string): void {
  try {
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        markStoreDirectoryReadOnly(fullPath);
      } else if (entry.isFile()) {
        try {
          fs.chmodSync(fullPath, 0o444);
        } catch {}
      }
    }
  } catch {}
}

export function markStoreDirectoryWritable(dirPath: string): void {
  try {
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        markStoreDirectoryWritable(fullPath);
      } else if (entry.isFile()) {
        try {
          fs.chmodSync(fullPath, 0o666);
        } catch {}
      }
    }
  } catch {}
}

export function runLifecycleScripts(
  storePackageDir: string,
  optionsOrPkgJson: any = {},
  allowList?: string[],
  allowBuildScripts?: boolean
): void {
  let opts: ExtractOptions = {};
  if (Array.isArray(allowList)) {
    opts = {
      onlyBuiltDependencies: allowList,
      allowAllScripts: Boolean(allowBuildScripts)
    };
  } else if (typeof optionsOrPkgJson === 'boolean') {
    opts = { ignoreScripts: optionsOrPkgJson };
  } else if (optionsOrPkgJson) {
    opts = optionsOrPkgJson;
  }

  if (opts.ignoreScripts) return;

  const pkgJsonPath = path.join(storePackageDir, 'package.json');
  let pkg: any = null;
  if (fs.existsSync(pkgJsonPath)) {
    try { pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')); } catch {}
  }
  if (!pkg && optionsOrPkgJson && optionsOrPkgJson.scripts) {
    pkg = optionsOrPkgJson;
  }
  if (!pkg) return;

  try {
    const script = pkg.scripts?.install || pkg.scripts?.postinstall;
    if (!script) return;

    // Supply-chain gating: default-deny (scripts do NOT run unless explicitly allowlisted)
    if (!opts.allowAllScripts) {
      if (!opts.onlyBuiltDependencies || opts.onlyBuiltDependencies.length === 0) {
        // Default-deny: no lifecycle scripts run without explicit opt-in
        return;
      }
      const allowed = opts.onlyBuiltDependencies;
      const baseName = pkg.name && pkg.name.startsWith('@') ? pkg.name.split('/')[1] : pkg.name;
      if (!allowed.includes(pkg.name) && !allowed.includes(baseName)) {
        // Block unapproved build script
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
    const fullPath = path.join(store, entry);
    markStoreDirectoryWritable(fullPath);
    fs.rmSync(fullPath, { recursive: true, force: true });
  }
  return { removedCount: entries.length };
}

export interface TamperedPackageReport {
  name: string;
  version: string;
  storeDir: string;
  reason: string;
  fixed?: boolean;
}

export interface StoreVerificationResult {
  valid: boolean;
  totalScanned: number;
  tamperedCount: number;
  fixedCount: number;
  tampered: TamperedPackageReport[];
  corruptedPackages: { package: string; issues: string[] }[];
}

export async function verifyStore(options: { fix?: boolean; storeDir?: string } = {}): Promise<StoreVerificationResult> {
  const store = options.storeDir || getStoreDir();
  const tarballsDir = path.join(store, '..', 'tarballs');
  const tampered: TamperedPackageReport[] = [];
  let totalScanned = 0;
  let fixedCount = 0;

  if (!fs.existsSync(store)) {
    return { valid: true, totalScanned: 0, tamperedCount: 0, fixedCount: 0, tampered: [], corruptedPackages: [] };
  }

  const entries = fs.readdirSync(store, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const safeName = entry.name;
    const realName = safeName.replace(/__/g, '/');
    const pkgDir = path.join(store, safeName);
    const versionDirs = fs.readdirSync(pkgDir, { withFileTypes: true }).filter(d => d.isDirectory());

    for (const vDir of versionDirs) {
      totalScanned++;
      const version = vDir.name;
      const targetDir = path.join(pkgDir, version);
      const pkgJsonPath = path.join(targetDir, 'package.json');

      let isTampered = false;
      let reason = '';

      if (!fs.existsSync(pkgJsonPath)) {
        isTampered = true;
        reason = 'Missing package.json in store directory';
      } else {
        try {
          const raw = fs.readFileSync(pkgJsonPath, 'utf-8');
          JSON.parse(raw);
        } catch {
          isTampered = true;
          reason = 'Corrupted package.json JSON syntax';
        }
      }

      if (!isTampered) {
        const integrityPath = path.join(targetDir, '.linkpm-integrity.json');
        if (fs.existsSync(integrityPath)) {
          try {
            const manifest = JSON.parse(fs.readFileSync(integrityPath, 'utf-8'));
            for (const [relFile, expectedHash] of Object.entries(manifest)) {
              const fullFile = path.join(targetDir, relFile);
              if (!fs.existsSync(fullFile)) {
                isTampered = true;
                reason = `Missing file ${relFile}`;
                break;
              }
              const fileBuf = fs.readFileSync(fullFile);
              const actualHash = `sha512-${crypto.createHash('sha512').update(fileBuf).digest('base64')}`;
              if (actualHash !== expectedHash) {
                isTampered = true;
                reason = `Integrity mismatch for ${relFile}`;
                break;
              }
            }
          } catch {}
        }
      }

      if (isTampered) {
        let fixed = false;
        if (options.fix) {
          const cleanVersion = version.split('_')[0];
          const tarballPath = path.join(tarballsDir, `${safeName}-${cleanVersion}.tgz`);
          if (fs.existsSync(tarballPath)) {
            try {
              markStoreDirectoryWritable(targetDir);
              fs.rmSync(targetDir, { recursive: true, force: true });
              fs.mkdirSync(targetDir, { recursive: true });
              await FetchManager.safeExtractTar(tarballPath, targetDir);
              markStoreDirectoryReadOnly(targetDir);
              fixed = true;
              fixedCount++;
            } catch {}
          }
        }
        tampered.push({
          name: realName,
          version,
          storeDir: targetDir,
          reason,
          fixed
        });
      }
    }
  }

  return {
    valid: tampered.length === 0,
    totalScanned,
    tamperedCount: tampered.length,
    fixedCount,
    tampered,
    corruptedPackages: tampered.map(t => ({
      package: `${t.name}@${t.version}`,
      issues: [t.reason]
    }))
  };
}
