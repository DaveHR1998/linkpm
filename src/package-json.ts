import fs from 'node:fs';
import path from 'node:path';
import { LinkPMError } from './utils/errors.js';

export interface ProjectPackageJson {
  name?: string;
  version?: string;
  type?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  [key: string]: any;
}

export function findProjectRoot(cwd: string = process.cwd()): string {
  let current = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, 'package.json'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return cwd;
    }
    current = parent;
  }
}

export function readPackageJson(projectRoot: string): ProjectPackageJson {
  const filePath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(filePath)) {
    return {
      name: path.basename(projectRoot),
      version: '1.0.0',
      type: 'module'
    };
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err: any) {
    throw new LinkPMError(`Syntax error in package.json at ${filePath}: ${err.message}`, {
      code: 'ERR_PROJECT_NOT_FOUND',
      hint: 'Fix the syntax error in your package.json before proceeding to avoid losing configuration.'
    });
  }
}

export function writePackageJson(projectRoot: string, data: ProjectPackageJson): void {
  const filePath = path.join(projectRoot, 'package.json');
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Returns the exact spec string the user originally declared so it can be
 * written back to package.json verbatim when it is a non-registry spec
 * (workspace:, file:, link:, git:, tarball, catalog:, npm: alias).
 * Plain registry adds use "^<version>" save-prefix semantics like npm.
 */
export function specForWriteback(declaredSpec: string, resolvedVersion: string): string {
  const trimmed = (declaredSpec || '').trim();

  // Spec forms like "name@<range>" or "alias@npm:real@range"
  const atIdx = trimmed.startsWith('@')
    ? trimmed.indexOf('@', 1)
    : trimmed.indexOf('@');
  const declaredRange = atIdx !== -1 ? trimmed.slice(atIdx + 1) : '';

  if (
    declaredRange.startsWith('workspace:') ||
    declaredRange.startsWith('file:') ||
    declaredRange.startsWith('link:') ||
    declaredRange.startsWith('git+') ||
    declaredRange.startsWith('git://') ||
    declaredRange.startsWith('github:') ||
    declaredRange.startsWith('catalog:') ||
    declaredRange.includes('npm:') ||
    /^https?:\/\//.test(declaredRange)
  ) {
    return declaredRange;
  }

  return `^${resolvedVersion}`;
}

export function addDependenciesToPackageJson(
  projectRoot: string,
  deps: Array<{ name: string; version: string; isDev: boolean; declaredSpec?: string }>,
  options: { saveExact?: boolean } = {}
): void {
  const pkg = readPackageJson(projectRoot);

  for (const dep of deps) {
    let versionSpec: string;
    if (dep.declaredSpec && specForWriteback(dep.declaredSpec, dep.version) !== `^${dep.version}`) {
      versionSpec = specForWriteback(dep.declaredSpec, dep.version);
    } else {
      versionSpec = options.saveExact ? dep.version : `^${dep.version}`;
    }
    if (dep.isDev) {
      if (!pkg.devDependencies) pkg.devDependencies = {};
      pkg.devDependencies[dep.name] = versionSpec;
      // Remove from dependencies if it was there
      if (pkg.dependencies && pkg.dependencies[dep.name]) {
        delete pkg.dependencies[dep.name];
      }
    } else {
      if (!pkg.dependencies) pkg.dependencies = {};
      pkg.dependencies[dep.name] = versionSpec;
      // Remove from devDependencies if it was there
      if (pkg.devDependencies && pkg.devDependencies[dep.name]) {
        delete pkg.devDependencies[dep.name];
      }
    }
  }

  writePackageJson(projectRoot, pkg);
}

export function removeDependenciesFromPackageJson(
  projectRoot: string,
  packageNames: string[]
): void {
  const pkg = readPackageJson(projectRoot);

  for (const name of packageNames) {
    if (pkg.dependencies && pkg.dependencies[name]) {
      delete pkg.dependencies[name];
    }
    if (pkg.devDependencies && pkg.devDependencies[name]) {
      delete pkg.devDependencies[name];
    }
  }

  writePackageJson(projectRoot, pkg);
}

export function getProjectOverrides(projectRoot: string): Record<string, string> {
  const pkg = readPackageJson(projectRoot);
  return {
    ...(pkg.resolutions || {}),
    ...(pkg.overrides || {}),
    ...(pkg.pnpm?.overrides || {}),
    ...(pkg.linkpm?.overrides || {})
  };
}

export function getOnlyBuiltDependencies(projectRoot: string): string[] | undefined {
  const pkg = readPackageJson(projectRoot);
  const list = pkg.onlyBuiltDependencies || pkg.pnpm?.onlyBuiltDependencies || pkg.linkpm?.onlyBuiltDependencies;
  return Array.isArray(list) ? list : undefined;
}

export function addOnlyBuiltDependencies(projectRoot: string, packageNames: string[]): string[] {
  const pkg = readPackageJson(projectRoot);
  const existing = new Set<string>(
    Array.isArray(pkg.onlyBuiltDependencies) ? pkg.onlyBuiltDependencies :
    (Array.isArray(pkg.pnpm?.onlyBuiltDependencies) ? pkg.pnpm.onlyBuiltDependencies :
    (Array.isArray(pkg.linkpm?.onlyBuiltDependencies) ? pkg.linkpm.onlyBuiltDependencies : []))
  );
  for (const name of packageNames) {
    existing.add(name);
  }
  const updated = Array.from(existing).sort();
  if (pkg.pnpm?.onlyBuiltDependencies) {
    pkg.pnpm.onlyBuiltDependencies = updated;
  } else if (pkg.linkpm?.onlyBuiltDependencies) {
    pkg.linkpm.onlyBuiltDependencies = updated;
  } else {
    pkg.onlyBuiltDependencies = updated;
  }
  writePackageJson(projectRoot, pkg);
  return updated;
}

export function getPatchedDependencies(projectRoot: string): Record<string, string> {
  const pkg = readPackageJson(projectRoot);
  return {
    ...(pkg.pnpm?.patchedDependencies || {}),
    ...(pkg.linkpm?.patchedDependencies || {})
  };
}

export function addPatchedDependency(projectRoot: string, packageKey: string, patchRelPath: string): void {
  const pkg = readPackageJson(projectRoot);
  if (!pkg.pnpm) pkg.pnpm = {};
  if (!pkg.pnpm.patchedDependencies) pkg.pnpm.patchedDependencies = {};
  pkg.pnpm.patchedDependencies[packageKey] = patchRelPath.replace(/\\/g, '/');
  writePackageJson(projectRoot, pkg);
}
