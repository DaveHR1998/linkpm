import fs from 'node:fs';
import path from 'node:path';

export interface WorkspaceConfig {
  root: string;
  type: 'pnpm-workspace' | 'package.json';
  globs: string[];
  catalogs: Record<string, Record<string, string>>;
}

export function findWorkspaceRoot(startDir: string = process.cwd()): WorkspaceConfig | null {
  let current = path.resolve(startDir);

  while (true) {
    // 1. Check for pnpm-workspace.yaml
    const pnpmWorkspace = path.join(current, 'pnpm-workspace.yaml');
    if (fs.existsSync(pnpmWorkspace)) {
      const parsed = parsePnpmWorkspaceYaml(pnpmWorkspace);
      return {
        root: current,
        type: 'pnpm-workspace',
        globs: parsed.globs,
        catalogs: parsed.catalogs
      };
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
            return {
              root: current,
              type: 'package.json',
              globs,
              catalogs: {}
            };
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

export interface ParsedPnpmWorkspace {
  globs: string[];
  catalogs: Record<string, Record<string, string>>;
}

export function parsePnpmWorkspaceYaml(filePath: string): ParsedPnpmWorkspace {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return parsePnpmWorkspaceContent(raw);
  } catch {
    return { globs: ['packages/*'], catalogs: {} };
  }
}

export function parsePnpmWorkspaceContent(content: string): ParsedPnpmWorkspace {
  const lines = content.split(/\r?\n/);
  const globs: string[] = [];
  const catalogs: Record<string, Record<string, string>> = {
    default: {}
  };

  type Section = 'none' | 'packages' | 'catalog' | 'catalogs';
  let section: Section = 'none';
  let currentNamedCatalog = '';

  for (const line of lines) {
    const rawLine = line;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Detect top-level sections (0 indentation)
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      if (trimmed === 'packages:' || trimmed.startsWith('packages:')) {
        section = 'packages';
        continue;
      }
      if (trimmed === 'catalog:' || trimmed.startsWith('catalog:')) {
        section = 'catalog';
        continue;
      }
      if (trimmed === 'catalogs:' || trimmed.startsWith('catalogs:')) {
        section = 'catalogs';
        currentNamedCatalog = '';
        continue;
      }
      section = 'none';
      continue;
    }

    if (section === 'packages') {
      if (trimmed.startsWith('-')) {
        const item = trimmed.replace(/^-+\s*/, '').replace(/['"]/g, '').trim();
        if (item) globs.push(item);
      }
    } else if (section === 'catalog') {
      const eqIdx = trimmed.indexOf(':');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim().replace(/['"]/g, '');
        const val = trimmed.slice(eqIdx + 1).trim().replace(/['"]/g, '');
        if (key && val) {
          catalogs['default'][key] = val;
        }
      }
    } else if (section === 'catalogs') {
      // Sub-catalog e.g. "  react18:"
      const indent = rawLine.search(/\S/);
      if (indent <= 2 && trimmed.endsWith(':')) {
        currentNamedCatalog = trimmed.slice(0, -1).trim();
        if (!catalogs[currentNamedCatalog]) {
          catalogs[currentNamedCatalog] = {};
        }
      } else {
        const eqIdx = trimmed.indexOf(':');
        if (eqIdx !== -1 && currentNamedCatalog) {
          const key = trimmed.slice(0, eqIdx).trim().replace(/['"]/g, '');
          const val = trimmed.slice(eqIdx + 1).trim().replace(/['"]/g, '');
          if (key && val) {
            catalogs[currentNamedCatalog][key] = val;
          }
        }
      }
    }
  }

  return {
    globs: globs.length > 0 ? globs : ['packages/*'],
    catalogs
  };
}

export function resolveCatalogDependency(
  catalogSpec: string,
  packageName: string,
  catalogs: Record<string, Record<string, string>>
): string | null {
  let catalogName = 'default';
  if (catalogSpec.startsWith('catalog:')) {
    const specified = catalogSpec.slice('catalog:'.length).trim();
    if (specified) {
      catalogName = specified;
    }
  }

  const catalog = catalogs[catalogName];
  if (!catalog) return null;
  return catalog[packageName] || null;
}
