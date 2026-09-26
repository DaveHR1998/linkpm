import fs from 'node:fs';
import path from 'node:path';

export interface WorkspaceConfig {
  root: string;
  type: 'pnpm-workspace' | 'package.json';
  globs: string[];
}

export function findWorkspaceRoot(startDir: string = process.cwd()): WorkspaceConfig | null {
  let current = path.resolve(startDir);

  while (true) {
    // 1. Check for pnpm-workspace.yaml
    const pnpmWorkspace = path.join(current, 'pnpm-workspace.yaml');
    if (fs.existsSync(pnpmWorkspace)) {
      const globs = parsePnpmWorkspaceYaml(pnpmWorkspace);
      return { root: current, type: 'pnpm-workspace', globs };
    }

    // 2. Check for package.json with workspaces field
    const pkgJsonPath = path.join(current, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        if (pkg.workspaces) {
          const globs = Array.isArray(pkg.workspaces)
            ? pkg.workspaces
            : (Array.isArray(pkg.workspaces.packages) ? pkg.workspaces.packages : []);
          if (globs.length > 0) {
            return { root: current, type: 'package.json', globs };
          }
        }
      } catch {}
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

export function parsePnpmWorkspaceYaml(filePath: string): string[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split(/\r?\n/);
    const patterns: string[] = [];

    let inPackagesBlock = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      if (trimmed === 'packages:' || trimmed.startsWith('packages:')) {
        inPackagesBlock = true;
        continue;
      }

      if (inPackagesBlock) {
        if (trimmed.startsWith('-')) {
          const item = trimmed.replace(/^-+\s*/, '').replace(/['"]/g, '').trim();
          if (item) patterns.push(item);
        } else if (/^[a-zA-Z0-9_-]+:/.test(trimmed)) {
          // New yaml section started
          break;
        }
      }
    }

    return patterns.length > 0 ? patterns : ['packages/*'];
  } catch {
    return ['packages/*'];
  }
}
