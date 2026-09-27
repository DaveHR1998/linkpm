import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { resolvePackage, downloadTarball, type ResolvedPackage, type ResolveOptions } from './registry.js';
import {
  isPackageInStore,
  extractToStore,
  getPackageStoreDir,
  linkToGlobalNodeModules,
  linkDependencyIntoStorePackage,
  registerProject
} from './store.js';
import { linkPackage, unlinkPackage, type LinkResult } from './linker.js';
import {
  addDependenciesToPackageJson,
  removeDependenciesFromPackageJson,
  readPackageJson,
  getProjectOverrides,
  getOnlyBuiltDependencies,
  getPatchedDependencies
} from './package-json.js';
import {
  updateLockfile,
  removeLockfileEntries,
  readLockfile,
  verifyLockfileIntegrity,
  LOCKFILE_NAME
} from './lockfile/index.js';
import { findPreset } from './presets.js';
import { LinkPMError } from './utils/errors.js';

export interface InstallOptions extends ResolveOptions {
  dev?: boolean;
  frozenLockfile?: boolean;
  noPrune?: boolean;
  ignoreScripts?: boolean;
  allowAllScripts?: boolean;
}

export interface InstallResult {
  name: string;
  version: string;
  tarballUrl: string;
  integrity?: string;
  isDev: boolean;
  fromStore: boolean;
  binsLinked: string[];
  depsCount?: number;
  dependencies?: Record<string, string>;
}

export function isMatchingPlatform(pkgName: string): boolean {
  const currentPlatform = process.platform; // 'win32', 'darwin', 'linux'
  const currentArch = process.arch; // 'x64', 'arm64'

  const knownPlatforms = ['win32', 'darwin', 'linux', 'android', 'freebsd', 'openbsd', 'sunos', 'aix', 'netbsd'];
  const hasPlatform = knownPlatforms.some(p => pkgName.includes(p));

  if (hasPlatform) {
    if (!pkgName.includes(currentPlatform)) return false;
    if (pkgName.includes('arm64') && currentArch !== 'arm64') return false;
    if (pkgName.includes('x64') && currentArch !== 'x64') return false;
    return true;
  }

  return true;
}

/**
 * Level 2: Per-Package Store Isolation
 * Ensures a package and all of its declared dependencies are downloaded into ~/.linkpm/store/
 * and that ~/.linkpm/store/<pkg>/<ver>/node_modules contains junctions to its exact dependencies.
 */
export async function ensurePackageInStore(
  spec: string,
  options: InstallOptions = {},
  visited: Set<string> = new Set()
): Promise<{ resolved: ResolvedPackage; storeDir: string; fromStore: boolean; depsLinked: number }> {
  const projectRoot = options.projectRoot || process.cwd();
  const overrides = options.overrides || getProjectOverrides(projectRoot);
  const resolved = await resolvePackage(spec, { ...options, overrides, projectRoot });

  // Handle local path dependency (file: or link:) directly
  if (resolved.isLocal && resolved.localPath) {
    return {
      resolved,
      storeDir: resolved.localPath,
      fromStore: true,
      depsLinked: 0
    };
  }

  const alreadyInStore = isPackageInStore(resolved.name, resolved.version);
  const storeDir = getPackageStoreDir(resolved.name, resolved.version);

  if (!alreadyInStore) {
    const tarballPath = await downloadTarball(resolved);

    // Check if there is an active patch for this package
    const patches = getPatchedDependencies(projectRoot);
    const patchRel = patches[`${resolved.name}@${resolved.version}`] || patches[resolved.name];
    const patchFile = patchRel ? path.resolve(projectRoot, patchRel) : undefined;
    const onlyBuilt = getOnlyBuiltDependencies(projectRoot);

    await extractToStore(resolved, tarballPath, {
      ignoreScripts: options.ignoreScripts,
      onlyBuiltDependencies: onlyBuilt,
      allowAllScripts: options.allowAllScripts,
      patchFile
    });
  }

  // Ensure global fallback in ~/.linkpm/node_modules/
  linkToGlobalNodeModules(resolved.name, storeDir);

  let depsLinked = 0;
  const depsToProcess: Array<{ name: string; range: string }> = [];

  if (resolved.dependencies) {
    for (const [depName, depRange] of Object.entries(resolved.dependencies)) {
      depsToProcess.push({ name: depName, range: depRange });
    }
  }

  if (resolved.optionalDependencies) {
    for (const [optName, optRange] of Object.entries(resolved.optionalDependencies)) {
      if (isMatchingPlatform(optName)) {
        depsToProcess.push({ name: optName, range: optRange });
      }
    }
  }

  // Batch process dependencies into storeDir/node_modules/
  const BATCH_SIZE = 5;
  for (let i = 0; i < depsToProcess.length; i += BATCH_SIZE) {
    const batch = depsToProcess.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async dep => {
        const depKey = `${dep.name}@${dep.range}`;
        if (visited.has(depKey) || dep.name === resolved.name) return;

        try {
          const nextVisited = new Set(visited);
          nextVisited.add(depKey);
          nextVisited.add(resolved.name);

          const depResult = await ensurePackageInStore(`${dep.name}@${dep.range}`, options, nextVisited);
          linkDependencyIntoStorePackage(storeDir, dep.name, depResult.storeDir);
          depsLinked++;
        } catch {
          // ignore non-critical optional dependency failures
        }
      })
    );
  }

  return { resolved, storeDir, fromStore: alreadyInStore, depsLinked };
}

export async function installSinglePackage(
  spec: string,
  projectRoot: string,
  options: InstallOptions = {}
): Promise<InstallResult> {
  registerProject(projectRoot);
  const opts: InstallOptions = {
    projectRoot,
    overrides: getProjectOverrides(projectRoot),
    ...options
  };

  const { resolved, storeDir, fromStore, depsLinked } = await ensurePackageInStore(spec, opts);

  // Link top-level package into project's node_modules/
  const linkRes = linkPackage(projectRoot, resolved.name, storeDir);

  return {
    name: resolved.name,
    version: resolved.version,
    tarballUrl: resolved.tarballUrl,
    integrity: resolved.integrity,
    isDev: Boolean(options.dev),
    fromStore,
    binsLinked: linkRes.binsLinked,
    depsCount: depsLinked,
    dependencies: resolved.dependencies
  };
}

export async function installPackages(
  specs: string[],
  projectRoot: string,
  options: InstallOptions = {}
): Promise<InstallResult[]> {
  registerProject(projectRoot);
  const results: InstallResult[] = [];
  const opts: InstallOptions = {
    projectRoot,
    overrides: getProjectOverrides(projectRoot),
    ...options
  };

  for (const spec of specs) {
    const startTime = Date.now();
    try {
      const res = await installSinglePackage(spec, projectRoot, opts);
      const elapsed = Date.now() - startTime;
      const cacheTag = res.fromStore ? pc.green('[cached]') : pc.cyan('[downloaded]');
      const binTag = res.binsLinked.length > 0 ? pc.dim(` (bin: ${res.binsLinked.join(', ')})`) : '';
      const depsTag = res.depsCount && res.depsCount > 0 ? pc.dim(` (isolated ${res.depsCount} deps)`) : '';

      console.log(
        `  ${pc.bold(pc.green('✔'))} ${pc.bold(res.name)}${pc.dim(`@${res.version}`)} ${cacheTag}${binTag}${depsTag} ${pc.dim(`${elapsed}ms`)}`
      );
      results.push(res);
    } catch (err: any) {
      console.error(`  ${pc.bold(pc.red('✖'))} ${pc.bold(spec)}: ${err.message}`);
      throw err;
    }
  }

  // Update package.json
  addDependenciesToPackageJson(
    projectRoot,
    results.map(r => ({ name: r.name, version: r.version, isDev: r.isDev }))
  );

  // Update linkpm-lock.json
  updateLockfile(
    projectRoot,
    results.map(r => ({
      name: r.name,
      version: r.version,
      tarballUrl: r.tarballUrl,
      integrity: r.integrity,
      isDev: r.isDev,
      dependencies: r.dependencies
    }))
  );

  return results;
}

export async function uninstallPackages(
  packageNames: string[],
  projectRoot: string
): Promise<string[]> {
  const removed: string[] = [];

  for (const name of packageNames) {
    const unlinked = unlinkPackage(projectRoot, name);
    if (unlinked) {
      removed.push(name);
      console.log(`  ${pc.bold(pc.green('✔'))} Unlinked ${pc.bold(name)} from node_modules`);
    } else {
      console.log(`  ${pc.dim('ℹ')} ${name} was not linked in node_modules`);
    }
  }

  // Remove from package.json
  removeDependenciesFromPackageJson(projectRoot, packageNames);

  // Remove from linkpm-lock.json
  removeLockfileEntries(projectRoot, packageNames);

  console.log(pc.green(`\n✔ Removed ${packageNames.length} package(s) from package.json and ${LOCKFILE_NAME}.`));
  return removed;
}

export function pruneExtraneousDependencies(projectRoot: string): string[] {
  const nmDir = path.join(projectRoot, 'node_modules');
  if (!fs.existsSync(nmDir)) return [];

  const pkg = readPackageJson(projectRoot);
  const declared = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {}),
    ...Object.keys(pkg.peerDependencies || {})
  ]);

  const pruned: string[] = [];
  const entries = fs.readdirSync(nmDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === '.bin' || entry.name.startsWith('.') || entry.name === 'linkpm-lock.json') {
      continue;
    }

    if (entry.name.startsWith('@')) {
      // Scoped folder
      const scopeDir = path.join(nmDir, entry.name);
      if (fs.existsSync(scopeDir) && fs.statSync(scopeDir).isDirectory()) {
        const scopedEntries = fs.readdirSync(scopeDir, { withFileTypes: true });
        for (const scopedEntry of scopedEntries) {
          const fullName = `${entry.name}/${scopedEntry.name}`;
          if (!declared.has(fullName)) {
            unlinkPackage(projectRoot, fullName);
            pruned.push(fullName);
          }
        }
        try {
          if (fs.readdirSync(scopeDir).length === 0) {
            fs.rmdirSync(scopeDir);
          }
        } catch {}
      }
    } else {
      if (!declared.has(entry.name)) {
        unlinkPackage(projectRoot, entry.name);
        pruned.push(entry.name);
      }
    }
  }

  return pruned;
}

export async function installPreset(
  presetInput: string,
  projectRoot: string,
  options: InstallOptions = {}
): Promise<InstallResult[]> {
  const preset = findPreset(presetInput);
  if (!preset) {
    throw new Error(`Preset "${presetInput}" not found. Run "linkpm preset list" to view available presets.`);
  }

  console.log(`\n${pc.bold(pc.cyan('⚡ Applying preset:'))} ${pc.bold(preset.name)} ${pc.dim(preset.description || '')}`);

  const allResults: InstallResult[] = [];

  if (preset.dependencies.length > 0) {
    console.log(`\n${pc.bold('Dependencies:')}`);
    const deps = await installPackages(preset.dependencies, projectRoot, { ...options, dev: false });
    allResults.push(...deps);
  }

  if (preset.devDependencies.length > 0) {
    console.log(`\n${pc.bold('DevDependencies:')}`);
    const devDeps = await installPackages(preset.devDependencies, projectRoot, { ...options, dev: true });
    allResults.push(...devDeps);
  }

  return allResults;
}

export async function installProjectDependencies(
  projectRoot: string,
  options: InstallOptions = {}
): Promise<InstallResult[]> {
  const pkg = readPackageJson(projectRoot);
  const deps = pkg.dependencies || {};
  const devDeps = pkg.devDependencies || {};

  // Check frozen lockfile mode
  if (options.frozenLockfile) {
    const integrity = verifyLockfileIntegrity(projectRoot);
    if (!integrity.valid) {
      throw new LinkPMError(`Lockfile is out of sync with package.json (--frozen-lockfile is enabled)`, {
        code: 'ERR_LOCKFILE_MISMATCH',
        hint: `Drifted dependencies:\n  ${integrity.errors.join('\n  ')}\nRun "linkpm install" without --frozen-lockfile to update lockfile.`
      });
    }
  }

  const depSpecs = Object.entries(deps).map(([name, ver]) => `${name}@${ver}`);
  const devDepSpecs = Object.entries(devDeps).map(([name, ver]) => `${name}@${ver}`);

  if (depSpecs.length === 0 && devDepSpecs.length === 0) {
    console.log(pc.yellow('No dependencies found in package.json to install.'));
    return [];
  }

  const allResults: InstallResult[] = [];

  if (depSpecs.length > 0) {
    console.log(pc.bold('\nInstalling dependencies:'));
    const res = await installPackages(depSpecs, projectRoot, { ...options, dev: false });
    allResults.push(...res);
  }

  if (devDepSpecs.length > 0) {
    console.log(pc.bold('\nInstalling devDependencies:'));
    const res = await installPackages(devDepSpecs, projectRoot, { ...options, dev: true });
    allResults.push(...res);
  }

  // Prune extraneous packages if not disabled
  if (!options.noPrune) {
    const pruned = pruneExtraneousDependencies(projectRoot);
    if (pruned.length > 0) {
      console.log(pc.dim(`\n  🧹 Pruned ${pruned.length} extraneous package(s) from node_modules: ${pruned.join(', ')}`));
    }
  }

  return allResults;
}

export async function installFromLockfile(
  projectRoot: string,
  options: InstallOptions = {}
): Promise<InstallResult[]> {
  // Check frozen lockfile integrity
  if (options.frozenLockfile) {
    const integrity = verifyLockfileIntegrity(projectRoot);
    if (!integrity.valid) {
      throw new LinkPMError(`Lockfile is out of sync with package.json (--frozen-lockfile is enabled)`, {
        code: 'ERR_LOCKFILE_MISMATCH',
        hint: `Drifted dependencies:\n  ${integrity.errors.join('\n  ')}`
      });
    }
  }

  const lockfile = readLockfile(projectRoot);
  if (!lockfile) {
    throw new Error(`No ${LOCKFILE_NAME} found in ${projectRoot}. Run "linkpm install" first to generate one.`);
  }

  const entries = Object.entries(lockfile.packages);
  if (entries.length === 0) {
    console.log(pc.yellow(`No packages in ${LOCKFILE_NAME}.`));
    return [];
  }

  console.log(pc.bold(pc.blue('⚡ linkpm ci:')) + pc.dim(` Installing ${entries.length} locked packages...`));

  const specs = entries.map(([key]) => key);
  const results = await installPackages(specs, projectRoot, options);

  if (!options.noPrune) {
    const pruned = pruneExtraneousDependencies(projectRoot);
    if (pruned.length > 0) {
      console.log(pc.dim(`  🧹 Pruned ${pruned.length} extraneous package(s): ${pruned.join(', ')}`));
    }
  }

  return results;
}
