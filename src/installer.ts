import pc from 'picocolors';
import { resolvePackage, downloadTarball, type ResolvedPackage, type ResolveOptions } from './registry.js';
import { isPackageInStore, extractToStore, getPackageStoreDir, linkToGlobalNodeModules, linkDependencyIntoStorePackage, registerProject } from './store.js';
import { linkPackage, unlinkPackage, type LinkResult } from './linker.js';
import { addDependenciesToPackageJson, removeDependenciesFromPackageJson, readPackageJson } from './package-json.js';
import { updateLockfile, removeLockfileEntries, readLockfile, LOCKFILE_NAME } from './lockfile.js';
import { findPreset } from './presets.js';

export interface InstallOptions extends ResolveOptions {
  dev?: boolean;
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
  options: ResolveOptions = {},
  visited: Set<string> = new Set()
): Promise<{ resolved: ResolvedPackage; storeDir: string; fromStore: boolean; depsLinked: number }> {
  const resolved = await resolvePackage(spec, options);
  const alreadyInStore = isPackageInStore(resolved.name, resolved.version);
  const storeDir = getPackageStoreDir(resolved.name, resolved.version);

  if (!alreadyInStore) {
    const tarballPath = await downloadTarball(resolved);
    await extractToStore(resolved, tarballPath);
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
  const { resolved, storeDir, fromStore, depsLinked } = await ensurePackageInStore(spec, options);

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

  for (const spec of specs) {
    const startTime = Date.now();
    try {
      const res = await installSinglePackage(spec, projectRoot, options);
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

  return allResults;
}

export async function installFromLockfile(
  projectRoot: string,
  options: InstallOptions = {}
): Promise<InstallResult[]> {
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
  return installPackages(specs, projectRoot, options);
}
