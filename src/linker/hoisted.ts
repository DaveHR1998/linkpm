import fs from 'node:fs';
import path from 'node:path';
import { LinkPMError } from '../utils/errors.js';
import { ensureNodeModules, safeRemoveLinkOrDir, linkBinaries, type LinkResult } from '../linker.js';

/**
 * Recursively copies or hardlinks package contents from store into target directory.
 * Attempts hardlinking first for instant zero-copy speed; falls back to real file copying
 * on cross-device filesystem boundaries (EXDEV) or restricted environments.
 */
export function copyOrHardlinkPackage(sourceDir: string, targetDir: string): void {
  if (!fs.existsSync(sourceDir)) {
    throw new LinkPMError(`Source directory does not exist: ${sourceDir}`, {
      code: 'ERR_STORE_CORRUPTION'
    });
  }

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    // Avoid copying nested node_modules or store-internal artifacts
    if (entry.name === 'node_modules' || entry.name === '.git') {
      continue;
    }

    const srcPath = path.join(sourceDir, entry.name);
    const destPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyOrHardlinkPackage(srcPath, destPath);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      // Remove destination file if already present
      if (fs.existsSync(destPath)) {
        try {
          fs.unlinkSync(destPath);
        } catch {}
      }

      // Try hardlink first; fallback to file copy
      let linked = false;
      try {
        fs.linkSync(srcPath, destPath);
        linked = true;
      } catch {
        linked = false;
      }

      if (!linked) {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}

/**
 * Links a package into project's node_modules using classic hoisted mode (npm-style flat real directory).
 * Unlike junction mode, the resulting package in node_modules is a physical directory
 * whose realpath resolves inside the project root, satisfying Metro, CocoaPods, and Android Gradle.
 */
export function linkHoistedPackage(
  projectRoot: string,
  packageName: string,
  storePackageDir: string
): LinkResult {
  if (!fs.existsSync(storePackageDir)) {
    throw new LinkPMError(`Cannot link package "${packageName}": store directory "${storePackageDir}" does not exist`, {
      code: 'ERR_STORE_CORRUPTION',
      packageName
    });
  }

  const nodeModulesDir = ensureNodeModules(projectRoot);

  let targetDir: string;
  if (packageName.startsWith('@')) {
    const [scope, pkgName] = packageName.split('/');
    const scopeDir = path.join(nodeModulesDir, scope);
    if (!fs.existsSync(scopeDir)) {
      fs.mkdirSync(scopeDir, { recursive: true });
    }
    targetDir = path.join(scopeDir, pkgName);
  } else {
    targetDir = path.join(nodeModulesDir, packageName);
  }

  // Remove existing link or directory safely
  safeRemoveLinkOrDir(targetDir);

  // Copy or hardlink files into real directory
  copyOrHardlinkPackage(storePackageDir, targetDir);

  // Link executable binaries
  const binsLinked = linkBinaries(projectRoot, packageName, storePackageDir);

  return {
    packageName,
    sourceDir: storePackageDir,
    targetDir,
    binsLinked
  };
}

export interface HoistDependencyItem {
  name: string;
  version: string;
  storeDir: string;
  parentName?: string;
}

/**
 * Hoists resolved transitive dependencies flatly into root node_modules/ (classic npm layout).
 * If a dependency already exists with a different version, it nests inside parent's node_modules.
 */
export function hoistDependencies(
  projectRoot: string,
  dependencies: HoistDependencyItem[]
): number {
  const nodeModulesDir = ensureNodeModules(projectRoot);
  let hoistedCount = 0;

  for (const dep of dependencies) {
    if (!dep.storeDir || !fs.existsSync(dep.storeDir)) continue;

    // Determine target location: root node_modules or nested
    let targetDir: string;
    let isNested = false;

    if (dep.name.startsWith('@')) {
      const [scope, pkgName] = dep.name.split('/');
      targetDir = path.join(nodeModulesDir, scope, pkgName);
    } else {
      targetDir = path.join(nodeModulesDir, dep.name);
    }

    if (fs.existsSync(targetDir)) {
      // Check if installed version matches
      try {
        const pkgJson = JSON.parse(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf-8'));
        if (pkgJson.version === dep.version) {
          // Already installed at root with compatible version
          continue;
        }
      } catch {}

      // Conflict: Nest inside parent's node_modules if parentName is available
      if (dep.parentName) {
        isNested = true;
        const parentDir = dep.parentName.startsWith('@')
          ? path.join(nodeModulesDir, ...dep.parentName.split('/'))
          : path.join(nodeModulesDir, dep.parentName);

        const parentNm = path.join(parentDir, 'node_modules');
        if (dep.name.startsWith('@')) {
          const [scope, pkgName] = dep.name.split('/');
          targetDir = path.join(parentNm, scope, pkgName);
        } else {
          targetDir = path.join(parentNm, dep.name);
        }
      }
    }

    // Safely remove prior directory if present
    safeRemoveLinkOrDir(targetDir);

    // Copy or hardlink
    copyOrHardlinkPackage(dep.storeDir, targetDir);
    hoistedCount++;

    // Link binaries if hoisted to root node_modules
    if (!isNested) {
      linkBinaries(projectRoot, dep.name, dep.storeDir);
    }
  }

  return hoistedCount;
}
