import fs from 'node:fs';
import path from 'node:path';
import { safePackageName } from '../config/index.js';
import { safeRemoveLinkOrDir } from '../linker.js';

export interface VirtualPackageOptions {
  projectRoot: string;
  name: string;
  version: string;
  storeDir: string;
  dependencies?: Record<string, string>; // depName -> storeDir or virtual link path
  contextHash?: string;
}

export interface VirtualPackageResult {
  virtualDir: string;
  packageLinkPath: string;
  virtualNodeModules: string;
}

/**
 * Returns the path to the project's virtual store directory (node_modules/.linkpm).
 */
export function getProjectVirtualStoreDir(projectRoot: string): string {
  return path.join(projectRoot, 'node_modules', '.linkpm');
}

import crypto from 'node:crypto';

/**
 * Computes a deterministic hash of resolved peer dependencies to isolate virtual store entries.
 */
export function computePeerContextHash(peers?: Record<string, string>): string {
  if (!peers || Object.keys(peers).length === 0) return '';
  const sorted = Object.keys(peers).sort().map(k => `${k}@${peers[k]}`).join(',');
  return crypto.createHash('sha256').update(sorted).digest('hex').slice(0, 8);
}

/**
 * Computes a unique key for a virtual package instance.
 */
export function getVirtualPackageKey(packageName: string, version: string, contextHash?: string): string {
  const safe = safePackageName(packageName);
  return contextHash ? `${safe}@${version}_${contextHash}` : `${safe}@${version}`;
}

/**
 * Creates an isolated virtual package entry inside projectRoot/node_modules/.linkpm/<key>/node_modules/.
 * Links the package itself and each of its dependencies into the virtual node_modules directory.
 */
export function createVirtualPackage(options: VirtualPackageOptions): VirtualPackageResult {
  const { projectRoot, name, version, storeDir, dependencies = {}, contextHash } = options;
  const key = getVirtualPackageKey(name, version, contextHash);
  const virtualStore = getProjectVirtualStoreDir(projectRoot);
  const virtualEntry = path.join(virtualStore, key);
  const virtualNm = path.join(virtualEntry, 'node_modules');

  if (!fs.existsSync(virtualNm)) {
    fs.mkdirSync(virtualNm, { recursive: true });
  }

  // 1. Create directory junction for the package itself inside its virtual node_modules
  let selfTarget: string;
  if (name.startsWith('@')) {
    const [scope, pkgName] = name.split('/');
    const scopeDir = path.join(virtualNm, scope);
    if (!fs.existsSync(scopeDir)) fs.mkdirSync(scopeDir, { recursive: true });
    selfTarget = path.join(scopeDir, pkgName);
  } else {
    selfTarget = path.join(virtualNm, name);
  }

  safeRemoveLinkOrDir(selfTarget);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(storeDir, selfTarget, linkType);

  // 2. Link each dependency into the virtual node_modules folder
  for (const [depName, depTargetDir] of Object.entries(dependencies)) {
    if (!depTargetDir || !fs.existsSync(depTargetDir)) continue;

    let depLinkPath: string;
    if (depName.startsWith('@')) {
      const [scope, subName] = depName.split('/');
      const scopeDir = path.join(virtualNm, scope);
      if (!fs.existsSync(scopeDir)) fs.mkdirSync(scopeDir, { recursive: true });
      depLinkPath = path.join(scopeDir, subName);
    } else {
      depLinkPath = path.join(virtualNm, depName);
    }

    safeRemoveLinkOrDir(depLinkPath);
    try {
      fs.symlinkSync(depTargetDir, depLinkPath, linkType);
    } catch {}
  }

  return {
    virtualDir: virtualEntry,
    packageLinkPath: selfTarget,
    virtualNodeModules: virtualNm
  };
}
