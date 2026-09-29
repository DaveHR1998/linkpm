import fs from 'node:fs';
import path from 'node:path';
import { readLockfile } from './lockfile/index.js';
import { readPackageJson } from './package-json.js';
import { LinkPMError } from './utils/errors.js';

export interface DeployOptions {
  outDir?: string;
  prod?: boolean;
}

export interface DeployResult {
  outDir: string;
  packagesCount: number;
  totalSize: number;
}

/**
 * Packages the application into a standalone, un-linked directory with real physical files
 * in node_modules, ready for Serverless (AWS Lambda, Vercel) and Docker containers.
 */
export async function deployProject(
  projectRoot: string,
  options: DeployOptions = {}
): Promise<DeployResult> {
  const targetDirName = options.outDir || 'dist-deploy';
  const outDir = path.resolve(projectRoot, targetDirName);

  if (outDir === path.resolve(projectRoot)) {
    throw new LinkPMError('Deployment directory cannot be the project root itself.', {
      code: 'ERR_INVALID_DEPLOY_DIR',
      hint: 'Specify a subdirectory like --out dist-deploy'
    });
  }

  // 1. Prepare target output directory
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });

  const pkgJson = readPackageJson(projectRoot);
  const isProd = options.prod !== false;

  // 2. Write deployment package.json (stripping devDependencies if prod mode)
  const deployPkgJson: any = {
    name: pkgJson.name || 'deployed-app',
    version: pkgJson.version || '1.0.0',
    type: pkgJson.type,
    main: pkgJson.main,
    scripts: pkgJson.scripts ? { start: pkgJson.scripts.start || 'node index.js' } : { start: 'node index.js' },
    dependencies: pkgJson.dependencies || {}
  };

  if (!isProd && pkgJson.devDependencies) {
    deployPkgJson.devDependencies = pkgJson.devDependencies;
  }

  fs.writeFileSync(
    path.join(outDir, 'package.json'),
    JSON.stringify(deployPkgJson, null, 2) + '\n',
    'utf-8'
  );

  // 3. Copy application project files (excluding node_modules, .git, cache, and outDir)
  const excludeList = new Set([
    'node_modules',
    '.git',
    '.linkpm',
    '.cursor',
    '.mcp-wire',
    'mcp-wire',
    'package.json',
    'package-lock.json',
    'linkpm-lock.json',
    targetDirName,
    path.basename(outDir)
  ]);

  const appEntries = fs.readdirSync(projectRoot, { withFileTypes: true });
  for (const entry of appEntries) {
    if (excludeList.has(entry.name)) continue;
    if (entry.name.startsWith('.linkpm')) continue;

    const srcPath = path.join(projectRoot, entry.name);
    const destPath = path.join(outDir, entry.name);

    try {
      fs.cpSync(srcPath, destPath, {
        recursive: true,
        dereference: true // Dereference symlinks to ensure real files
      });
    } catch {}
  }

  // 4. Copy real physical dependencies into dist-deploy/node_modules/
  const deployNmDir = path.join(outDir, 'node_modules');
  fs.mkdirSync(deployNmDir, { recursive: true });

  const rootNm = path.join(projectRoot, 'node_modules');
  let packagesCount = 0;

  const targetDependencies = isProd
    ? Object.keys(pkgJson.dependencies || {})
    : Object.keys({ ...(pkgJson.dependencies || {}), ...(pkgJson.devDependencies || {}) });

  // Helper to copy a package into deployNmDir with real physical files
  const copyPackageToDeploy = (name: string, srcDir: string) => {
    let destDir = path.join(deployNmDir, name);
    if (name.startsWith('@')) {
      const [scope] = name.split('/');
      const destScope = path.join(deployNmDir, scope);
      if (!fs.existsSync(destScope)) fs.mkdirSync(destScope, { recursive: true });
    }

    try {
      fs.cpSync(srcDir, destDir, {
        recursive: true,
        dereference: true // Resolves all junctions & symlinks into real standalone physical files
      });
      packagesCount++;
    } catch {}
  };

  if (fs.existsSync(rootNm)) {
    // Top-level dependencies
    for (const dep of targetDependencies) {
      const depSrc = path.join(rootNm, dep);
      if (fs.existsSync(depSrc)) {
        copyPackageToDeploy(dep, depSrc);
      }
    }

    // Transitive dependencies from node_modules
    const entries = fs.readdirSync(rootNm, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '.bin') continue;
      if (entry.name.startsWith('@')) {
        const scopePath = path.join(rootNm, entry.name);
        if (fs.existsSync(scopePath)) {
          const scopedEntries = fs.readdirSync(scopePath, { withFileTypes: true });
          for (const sEntry of scopedEntries) {
            const fullName = `${entry.name}/${sEntry.name}`;
            const sPath = path.join(scopePath, sEntry.name);
            const targetDest = path.join(deployNmDir, fullName);
            if (!fs.existsSync(targetDest)) {
              copyPackageToDeploy(fullName, sPath);
            }
          }
        }
      } else {
        const targetDest = path.join(deployNmDir, entry.name);
        if (!fs.existsSync(targetDest)) {
          copyPackageToDeploy(entry.name, path.join(rootNm, entry.name));
        }
      }
    }
  }

  // 5. Generate clean production package-lock.json inside deploy directory
  const lockfile = readLockfile(projectRoot);
  if (lockfile) {
    const deployNpmPackages: Record<string, any> = {
      '': {
        name: deployPkgJson.name,
        version: deployPkgJson.version,
        dependencies: deployPkgJson.dependencies
      }
    };

    for (const [key, entry] of Object.entries(lockfile.packages)) {
      if (isProd && entry.isDev) continue;
      const atIdx = key.lastIndexOf('@');
      const name = atIdx > 0 ? key.slice(0, atIdx) : key;
      deployNpmPackages[`node_modules/${name}`] = {
        version: entry.version,
        resolved: entry.resolved,
        integrity: entry.integrity,
        dependencies: entry.dependencies
      };
    }

    const deployNpmLock = {
      name: deployPkgJson.name,
      version: deployPkgJson.version,
      lockfileVersion: 3,
      requires: true,
      packages: deployNpmPackages
    };

    fs.writeFileSync(
      path.join(outDir, 'package-lock.json'),
      JSON.stringify(deployNpmLock, null, 2) + '\n',
      'utf-8'
    );
  }

  // Calculate total deployed directory size
  let totalSize = 0;
  const calcSize = (dir: string) => {
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          calcSize(full);
        } else if (item.isFile()) {
          totalSize += fs.statSync(full).size;
        }
      }
    } catch {}
  };
  calcSize(outDir);

  return {
    outDir,
    packagesCount,
    totalSize
  };
}
