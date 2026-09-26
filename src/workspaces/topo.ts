import { WorkspacePackage } from './discovery.js';

export function filterWorkspacePackages(packages: WorkspacePackage[], filterPattern?: string): WorkspacePackage[] {
  if (!filterPattern) return packages;

  // Exact or wildcard filter
  if (filterPattern.includes('*')) {
    const regex = new RegExp('^' + filterPattern.replace(/\*/g, '.*') + '$');
    return packages.filter(p => regex.test(p.name));
  }

  return packages.filter(p => p.name === filterPattern);
}

export function sortWorkspacePackagesTopologically(packages: WorkspacePackage[]): WorkspacePackage[] {
  const packageMap = new Map<string, WorkspacePackage>();
  for (const p of packages) {
    packageMap.set(p.name, p);
  }

  // Build dependency map: package -> Set of workspace packages it depends on
  const depsMap = new Map<string, Set<string>>();
  for (const p of packages) {
    const deps = new Set<string>();
    const declared = {
      ...(p.pkgJson.dependencies || {}),
      ...(p.pkgJson.devDependencies || {})
    };
    for (const depName of Object.keys(declared)) {
      if (packageMap.has(depName)) {
        deps.add(depName);
      }
    }
    depsMap.set(p.name, deps);
  }

  const result: WorkspacePackage[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(pkgName: string) {
    if (visited.has(pkgName)) return;
    if (visiting.has(pkgName)) {
      // Cycle detected - break gracefully
      return;
    }

    visiting.add(pkgName);

    const dependencies = depsMap.get(pkgName) || new Set();
    for (const dep of dependencies) {
      visit(dep);
    }

    visiting.delete(pkgName);
    visited.add(pkgName);

    const pkgObj = packageMap.get(pkgName);
    if (pkgObj) {
      result.push(pkgObj);
    }
  }

  for (const p of packages) {
    visit(p.name);
  }

  return result;
}
