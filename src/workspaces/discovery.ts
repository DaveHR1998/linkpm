import fs from 'node:fs';
import path from 'node:path';

export interface WorkspacePackage {
  name: string;
  version: string;
  directory: string;
  manifestPath: string;
  pkgJson: any;
}

export function discoverWorkspacePackages(workspaceRoot: string, globs: string[]): WorkspacePackage[] {
  const packages: WorkspacePackage[] = [];
  const visitedDirs = new Set<string>();

  for (const pattern of globs) {
    // If exclusion pattern (e.g. !**/test/**)
    if (pattern.startsWith('!')) continue;

    // Clean pattern
    const cleanPattern = pattern.replace(/[\\/]+$/, '');

    if (cleanPattern.endsWith('/*')) {
      const baseDir = path.join(workspaceRoot, cleanPattern.slice(0, -2));
      if (fs.existsSync(baseDir) && fs.statSync(baseDir).isDirectory()) {
        const entries = fs.readdirSync(baseDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
            const dir = path.join(baseDir, entry.name);
            inspectAndAddPackage(dir, packages, visitedDirs);
          }
        }
      }
    } else if (cleanPattern.endsWith('/**')) {
      const baseDir = path.join(workspaceRoot, cleanPattern.slice(0, -3));
      scanDeep(baseDir, packages, visitedDirs);
    } else {
      const targetDir = path.join(workspaceRoot, cleanPattern);
      if (fs.existsSync(targetDir) && fs.statSync(targetDir).isDirectory()) {
        inspectAndAddPackage(targetDir, packages, visitedDirs);
      }
    }
  }

  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

function scanDeep(dir: string, packages: WorkspacePackage[], visited: Set<string>): void {
  if (!fs.existsSync(dir) || visited.has(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'dist' || entry.name === 'build') {
      continue;
    }
    const full = path.join(dir, entry.name);
    inspectAndAddPackage(full, packages, visited);
    scanDeep(full, packages, visited);
  }
}

function inspectAndAddPackage(dir: string, packages: WorkspacePackage[], visited: Set<string>): void {
  const norm = path.resolve(dir);
  if (visited.has(norm)) return;
  visited.add(norm);

  const manifestPath = path.join(norm, 'package.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      const pkg = JSON.parse(raw);
      if (pkg.name) {
        packages.push({
          name: pkg.name,
          version: pkg.version || '0.0.0',
          directory: norm,
          manifestPath,
          pkgJson: pkg
        });
      }
    } catch {}
  }
}
