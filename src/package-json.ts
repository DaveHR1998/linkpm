import fs from 'node:fs';
import path from 'node:path';

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
  return cwd;
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
  } catch {
    return {
      name: path.basename(projectRoot),
      version: '1.0.0',
      type: 'module'
    };
  }
}

export function writePackageJson(projectRoot: string, data: ProjectPackageJson): void {
  const filePath = path.join(projectRoot, 'package.json');
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

export function addDependenciesToPackageJson(
  projectRoot: string,
  deps: Array<{ name: string; version: string; isDev: boolean }>
): void {
  const pkg = readPackageJson(projectRoot);

  for (const dep of deps) {
    const versionSpec = `^${dep.version}`;
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
