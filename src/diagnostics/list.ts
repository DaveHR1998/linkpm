import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { readLockfile } from '../lockfile/index.js';
import { readPackageJson } from '../package-json.js';

export interface ListedPackage {
  name: string;
  version: string;
  from: 'lockfile' | 'node_modules' | 'unknown';
}

export interface ListResult {
  dependencies: ListedPackage[];
  devDependencies: ListedPackage[];
}

/**
 * Lists top-level installed packages with their resolved versions.
 * Versions come from the lockfile (authoritative) with a node_modules fallback
 * so listing still works on projects installed by other package managers.
 */
export function listInstalled(projectRoot: string): ListResult {
  const pkg = readPackageJson(projectRoot);
  const lock = readLockfile(projectRoot);

  const versionFromNodeModules = (name: string): string | null => {
    const p = path.join(projectRoot, 'node_modules', name, 'package.json');
    if (!fs.existsSync(p)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return data.version || null;
    } catch {
      return null;
    }
  };

  const resolveVersion = (name: string): { version: string; from: ListedPackage['from'] } => {
    if (lock?.packages) {
      let best: string | null = null;
      for (const [key, info] of Object.entries(lock.packages)) {
        const atIdx = key.lastIndexOf('@');
        if (atIdx <= 0 || key.slice(0, atIdx) !== name) continue;
        if (!best || info.version > best) best = info.version;
      }
      if (best) return { version: best, from: 'lockfile' };
    }
    const nmVersion = versionFromNodeModules(name);
    if (nmVersion) return { version: nmVersion, from: 'node_modules' };
    return { version: '(not installed)', from: 'unknown' };
  };

  const map = (names: string[]): ListedPackage[] =>
    names.sort((a, b) => a.localeCompare(b)).map(name => ({ name, ...resolveVersion(name) }));

  return {
    dependencies: map(Object.keys(pkg.dependencies || {})),
    devDependencies: map(Object.keys(pkg.devDependencies || {}))
  };
}

export function printInstalledList(projectRoot: string): void {
  const result = listInstalled(projectRoot);
  const pkg = readPackageJson(projectRoot);

  console.log(pc.bold(`\n${pc.blue(pc.bold('Legend:'))} production dependency, ${pc.dim('dev only')}\n`));
  console.log(pc.dim(`${pkg.name || 'project'}@${pkg.version || '0.0.0'} ${projectRoot}\n`));

  const printSection = (title: string, items: ListedPackage[], dim: boolean) => {
    if (items.length === 0) return;
    console.log(pc.bold(`${title}:`));
    for (const item of items) {
      const nameText = dim ? pc.dim(item.name) : item.name;
      const versionText = item.from === 'unknown'
        ? pc.red(item.version)
        : (dim ? pc.dim(pc.green(item.version)) : pc.green(item.version));
      console.log(`  ${nameText} ${pc.dim('@') + versionText}`);
    }
    console.log('');
  };

  printSection('dependencies', result.dependencies, false);
  printSection('devDependencies', result.devDependencies, true);

  if (result.dependencies.length === 0 && result.devDependencies.length === 0) {
    console.log(pc.yellow('  No dependencies declared in package.json.\n'));
  }
}
