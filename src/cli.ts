import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cac } from 'cac';
import pc from 'picocolors';
import { ensureDirectories, getStoreDir, setStoreDir, LINKPM_HOME, GLOBAL_BIN_DIR } from './config/index.js';
import { findProjectRoot, writePackageJson, readPackageJson } from './package-json.js';
import {
  installPackages,
  installPreset,
  installProjectDependencies,
  uninstallPackages,
  installFromLockfile
} from './installer.js';
import { listPresets, findPreset, saveCustomPreset, removeCustomPreset } from './presets.js';
import { listStore, clearStore, runGarbageCollection, getRegisteredProjects, verifyStore } from './store.js';
import { scaffoldProject } from './scaffolder.js';
import { runApproveBuilds } from './scripts/approve.js';
import { runDoctor, printDoctorResults } from './diagnostics/doctor.js';
import { checkOutdated, printOutdatedTable } from './diagnostics/outdated.js';
import { runSecurityAudit, printAuditResults, formatSarifReport } from './diagnostics/audit.js';
import { importLockfile, syncNpmPackageLock, readLockfile } from './lockfile/index.js';
import { DependencyResolver } from './resolver/index.js';
import { runScript, execBin, runDlx } from './scripts/index.js';
import { LinkPMError } from './utils/errors.js';
import { preparePatch, commitPatch } from './patches/index.js';
import {
  runWorkspaceScript,
  findWorkspaceRoot,
  discoverWorkspacePackages,
  linkWorkspaceDependencies
} from './workspaces/index.js';
import {
  scanAndSyncAllAICapabilities,
  printAICapabilities,
  readProjectAIRegistry,
  removeAICapabilityFromConfigs
} from './ai/index.js';
import { deployProject } from './deploy.js';
import { initMetroConfig } from './metro/index.js';
import { initIdeConfig } from './ide/index.js';
import { printInstalledList } from './diagnostics/list.js';
import { installGlobalPackages, printGlobalPathInstructions } from './global.js';
import { scheduleUpdateNotice } from './updater.js';
import type { LinkerMode } from './config/npmrc.js';

const cli = cac('linkpm');

// Support --store-dir passed anywhere in CLI
const storeDirArgIdx = process.argv.indexOf('--store-dir');
if (storeDirArgIdx !== -1 && process.argv[storeDirArgIdx + 1]) {
  setStoreDir(process.argv[storeDirArgIdx + 1]);
}

ensureDirectories();

const handleFatal = (err: any) => {
  if (err instanceof LinkPMError) {
    console.error(`\n${pc.bold(pc.red('✖ Error'))} [${pc.dim(err.code)}]: ${err.message}`);
    if (err.hint) {
      console.error(`  ${pc.cyan('💡 Hint:')} ${err.hint}\n`);
    }
    process.exit(1);
  }
  console.error(`\n${pc.bold(pc.red('✖ Fatal error:'))} ${err?.message || err}\n`);
  process.exit(1);
};

process.on('unhandledRejection', handleFatal);
process.on('uncaughtException', handleFatal);

// 0. CREATE / SCAFFOLD COMMAND
cli
  .command('create <template> [projectName]', 'Create a complete ready-to-run project (frontend, backend, fastify)')
  .action(async (template: string, projectName: string) => {
    try {
      await scaffoldProject(template, projectName);
    } catch (err: any) {
      console.error(pc.red(`\n✖ Error: ${err.message}`));
      process.exit(1);
    }
  });

// 1. USE / APPLY PRESET COMMAND
cli
  .command('use <preset>', 'Apply a preset stack to current project (e.g. linkpm use frontend)')
  .option('--offline', 'Force offline mode (use only cached packages)')
  .option('--prefer-offline', 'Prefer cached packages in store if available')
  .action(async (presetName: string, options: { offline?: boolean; preferOffline?: boolean }) => {
    if (!presetName) {
      console.log(pc.yellow('Please specify a preset name. Run "linkpm preset list" to view available presets.'));
      return;
    }

    const projectRoot = findProjectRoot();
    console.log(pc.bold(pc.blue('⚡ linkpm')) + pc.dim(` working in ${projectRoot}`));
    await installPreset(presetName, projectRoot, options);
    console.log(pc.green('\n✨ Done! Preset packages linked and package.json updated.'));
  });

// 2. ADD COMMAND
cli
  .command('add [...packages]', 'Add packages or presets to current project')
  .option('-D, --dev', 'Save packages as devDependencies')
  .option('-P, --preset <presetName>', 'Specify a preset to install')
  .option('--offline', 'Force offline mode (use only cached packages)')
  .option('--prefer-offline', 'Prefer cached packages in store if available')
  .option('--linker <mode>', 'Linker mode: junction (zero-copy default) or hoisted (flat node_modules for React Native)')
  .option('--ai', 'Enable automatic AI capability discovery (MCP servers, agent skills)')
  .option('--ignore-release-age', 'Bypass minimum release age cooldown for urgent hotfixes')
  .option('--allow-exotic-transitive', 'Allow transitive git, tarball, and local path dependencies')
  .option('-E, --exact', 'Save exact versions instead of ^ ranges')
  .option('-g, --global', 'Install package(s) globally into the shared linkpm global root')
  .option('-y, --yes', 'Automatically confirm prompts without interactive questions')
  .action(async (packages: string[], options: { dev?: boolean; preset?: string; offline?: boolean; preferOffline?: boolean; linker?: LinkerMode; ai?: boolean; yes?: boolean; exact?: boolean; global?: boolean; ignoreReleaseAge?: boolean; allowExoticTransitive?: boolean }) => {
    // Global install (pnpm add -g parity) — does not touch the project
    if (options.global) {
      if (!packages || packages.length === 0) {
        console.log(pc.yellow('Please specify at least one package to install globally.'));
        console.log(pc.dim('Example: linkpm add -g typescript tsx'));
        return;
      }
      console.log(pc.bold(pc.blue('⚡ linkpm')) + pc.dim(` installing globally: ${packages.join(', ')}`));
      const res = await installGlobalPackages(packages, options);
      for (const r of res.results) {
        console.log(`  ${pc.bold(pc.green('✔'))} ${pc.bold(r.name)}${pc.dim(`@${r.version}`)}`);
      }
      console.log(pc.green('\n✨ Done! Packages installed to the linkpm global root.'));
      printGlobalPathInstructions(res.binDir, res.binsCopied);
      return;
    }

    const projectRoot = findProjectRoot();

    // If --preset was passed
    if (options.preset) {
      console.log(pc.bold(pc.blue('⚡ linkpm')) + pc.dim(` working in ${projectRoot}`));
      await installPreset(options.preset, projectRoot, options);
      console.log(pc.green('\n✨ Done! Preset packages linked and package.json updated.'));
      return;
    }

    if (!packages || packages.length === 0) {
      console.log(pc.yellow('Please specify at least one package or preset to add.'));
      console.log(pc.dim('Examples:'));
      console.log(pc.cyan('  linkpm add express cors dotenv'));
      console.log(pc.cyan('  linkpm use frontend'));
      console.log(pc.cyan('  linkpm use backend'));
      return;
    }

    console.log(pc.bold(pc.blue('⚡ linkpm')) + pc.dim(` working in ${projectRoot}`));

    for (const pkg of packages) {
      // Check if it's a preset (@backend, @frontend, etc.)
      const matchedPreset = pkg.startsWith('@') ? findPreset(pkg) : null;
      if (matchedPreset) {
        await installPreset(pkg, projectRoot, options);
      } else {
        await installPackages([pkg], projectRoot, options);
      }
    }

    console.log(pc.green('\n✨ Done! All packages linked, package.json and linkpm-lock.json updated.'));
  });

// 3. REMOVE / UNINSTALL COMMAND
cli
  .command('remove [...packages]', 'Remove packages from current project')
  .alias('rm')
  .alias('uninstall')
  .option('-g, --global', 'Remove package(s) from the linkpm global root')
  .action(async (packages: string[], options: { global?: boolean }) => {
    if (!packages || packages.length === 0) {
      console.log(pc.yellow('Please specify at least one package to remove.'));
      console.log(pc.dim('Example: linkpm remove lodash axios'));
      return;
    }

    const projectRoot = options.global
      ? path.join(LINKPM_HOME, 'global')
      : findProjectRoot();
    console.log(pc.bold(pc.blue('⚡ linkpm remove:')) + pc.dim(` Removing packages from ${projectRoot}\n`));
    await uninstallPackages(packages, projectRoot);
    if (options.global) {
      // Also drop any copied global bin shims
      for (const name of packages) {
        for (const suffix of ['', '.cmd', '.ps1']) {
          try { fs.rmSync(path.join(GLOBAL_BIN_DIR, `${name.startsWith('@') ? name.split('/')[1] : name}${suffix}`), { force: true }); } catch {}
        }
      }
    }
  });

// 4. INSTALL / I COMMAND
cli
  .command('install [...packages]', 'Install all dependencies from package.json, or add specific packages (alias of linkpm add)')
  .alias('i')
  .option('-D, --dev', 'Save packages as devDependencies (only when adding specific packages)')
  .option('--prod', 'Install only production dependencies (skip devDependencies)')
  .option('--offline', 'Force offline mode (use only cached packages)')
  .option('--prefer-offline', 'Prefer cached packages in store if available')
  .option('--linker <mode>', 'Linker mode: junction (zero-copy default) or hoisted (flat node_modules for React Native)')
  .option('--frozen', 'Strictly verify lockfile against package.json without modifying it (CI mode)')
  .option('--frozen-lockfile', 'Fail installation if lockfile is out of date')
  .option('--no-prune', 'Do not prune extraneous packages from node_modules')
  .option('--ignore-scripts', 'Do not run package install/postinstall lifecycle scripts')
  .option('--allow-build-scripts', 'Allow all package build scripts without supply-chain restrictions')
  .option('--ignore-release-age', 'Bypass minimum release age cooldown for urgent hotfixes')
  .option('--allow-exotic-transitive', 'Allow transitive git, tarball, and local path dependencies')
  .action(async (packages: string[], options: {
    dev?: boolean;
    prod?: boolean;
    offline?: boolean;
    preferOffline?: boolean;
    linker?: LinkerMode;
    frozen?: boolean;
    frozenLockfile?: boolean;
    noPrune?: boolean;
    ignoreScripts?: boolean;
    allowAllScripts?: boolean;
    ignoreReleaseAge?: boolean;
    allowExoticTransitive?: boolean;
  }) => {
    const projectRoot = findProjectRoot();

    // `linkpm install <pkg>` behaves like `linkpm add <pkg>` (pnpm parity)
    if (packages && packages.length > 0) {
      console.log(pc.bold(pc.blue('⚡ linkpm')) + pc.dim(` working in ${projectRoot}`));
      await installPackages(packages, projectRoot, { ...options, dev: Boolean(options.dev) });
      console.log(pc.green('\n✨ Done! All packages linked, package.json and linkpm-lock.json updated.'));
      return;
    }

    const isFrozen = Boolean(options.frozen || options.frozenLockfile || (process.env.CI && options.frozenLockfile !== false && options.frozen !== false));
    console.log(pc.bold(pc.blue('⚡ linkpm')) + pc.dim(` installing dependencies in ${projectRoot}${isFrozen ? ' (frozen mode)' : ''}${options.prod ? ' (production only)' : ''}`));
    await installProjectDependencies(projectRoot, { ...options, frozenLockfile: isFrozen });
    console.log(pc.green('\n✨ Done! All dependencies linked from central store.'));
  });

// 5. CI (CLEAN INSTALL FROM LOCKFILE)
cli
  .command('ci', 'Install exact locked dependencies from linkpm-lock.json')
  .option('--offline', 'Force offline mode')
  .option('--prod', 'Install only production dependencies (skip devDependencies)')
  .option('--linker <mode>', 'Linker mode: junction (zero-copy default) or hoisted (flat node_modules for React Native)')
  .option('--frozen', 'Strictly verify lockfile against package.json')
  .option('--frozen-lockfile', 'Strictly verify lockfile against package.json')
  .option('--no-prune', 'Do not prune extraneous packages')
  .option('--ignore-scripts', 'Do not run package install/postinstall lifecycle scripts')
  .action(async (options: {
    offline?: boolean;
    prod?: boolean;
    linker?: LinkerMode;
    frozen?: boolean;
    frozenLockfile?: boolean;
    noPrune?: boolean;
    ignoreScripts?: boolean;
  }) => {
    const projectRoot = findProjectRoot();
    try {
      const isFrozen = options.frozen !== false && options.frozenLockfile !== false;
      await installFromLockfile(projectRoot, { ...options, frozenLockfile: isFrozen });
      console.log(pc.green('\n✨ Done! All locked dependencies linked successfully.'));
    } catch (err: any) {
      console.error(pc.red(`\n✖ Error: ${err.message}`));
      process.exit(1);
    }
  });

// 6. UPDATE / UPGRADE COMMAND
cli
  .command('update [...packages]', 'Update packages to their latest versions')
  .alias('upgrade')
  .action(async (packages: string[]) => {
    const projectRoot = findProjectRoot();
    const pkg = readPackageJson(projectRoot);

    const targetPackages = packages && packages.length > 0
      ? packages
      : Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });

    if (targetPackages.length === 0) {
      console.log(pc.yellow('No packages found to update.'));
      return;
    }

    console.log(pc.bold(pc.blue('⚡ linkpm update:')) + pc.dim(` Refreshing ${targetPackages.length} package(s) against registry...\n`));
    const specs = targetPackages.map(p => `${p}@latest`);
    await installPackages(specs, projectRoot, { preferOffline: false, useLockfile: false });
    console.log(pc.green('\n✨ Done! All packages updated to latest versions.'));
  });

// 7. PRESET COMMANDS
cli
  .command('preset [action] [name] [...pkgs]', 'Manage presets (list, use, save, remove)')
  .option('-d, --dev <devPkgs>', 'Dev dependencies for the preset (comma-separated)')
  .option('--desc <description>', 'Description for the preset')
  .action(async (action: string, name: string, pkgs: string[], options: { dev?: string; desc?: string }) => {
    const act = (action || 'list').toLowerCase();

    if (act === 'list') {
      const presets = listPresets();
      console.log(pc.bold('\n📦 Available linkpm Presets:\n'));
      for (const p of presets) {
        const tag = p.isBuiltin ? pc.cyan('[built-in]') : pc.green('[custom]');
        console.log(`  ${pc.bold(pc.magenta(p.name))} ${tag} ${pc.dim(p.description || '')}`);
        if (p.dependencies.length > 0) {
          console.log(`    ${pc.dim('deps:')} ${p.dependencies.join(', ')}`);
        }
        if (p.devDependencies.length > 0) {
          console.log(`    ${pc.dim('devDeps:')} ${p.devDependencies.join(', ')}`);
        }
        console.log('');
      }
      console.log(pc.dim('To apply a preset, run: ') + pc.cyan('linkpm use <preset>') + '\n');
      return;
    }

    if (act === 'use' || act === 'apply') {
      if (!name) {
        console.log(pc.red('Error: Please provide the preset name to use.'));
        console.log(pc.dim('Example: linkpm preset use frontend'));
        return;
      }
      const projectRoot = findProjectRoot();
      await installPreset(name, projectRoot);
      console.log(pc.green('\n✨ Done! Preset packages linked and package.json updated.'));
      return;
    }

    if (act === 'save') {
      if (!name) {
        console.log(pc.red('Error: Please provide a name for the preset.'));
        console.log(pc.dim('Example: linkpm preset save my-stack react react-dom -d vite,tailwindcss'));
        return;
      }
      const deps = pkgs || [];
      const devDeps = options.dev ? options.dev.split(',').map(s => s.trim()).filter(Boolean) : [];
      saveCustomPreset(name, deps, devDeps, options.desc);
      console.log(pc.green(`✔ Saved custom preset: ${name.replace(/^@/, '')}`));
      return;
    }

    if (act === 'remove' || act === 'rm') {
      if (!name) {
        console.log(pc.red('Error: Please provide the name of the preset to remove.'));
        return;
      }
      const removed = removeCustomPreset(name);
      if (removed) {
        console.log(pc.green(`✔ Removed preset: ${name.replace(/^@/, '')}`));
      } else {
        console.log(pc.yellow(`Preset "${name.replace(/^@/, '')}" not found in custom presets.`));
      }
      return;
    }

    console.log(pc.yellow(`Unknown preset action "${action}". Available: list, use, save, remove.`));
  });

// 8. STORE COMMANDS
cli
  .command('store [action]', 'Manage central store (list, status, gc, prune, clear, path)')
  .option('--dry-run', 'Simulate garbage collection without deleting any files')
  .option('--days <number>', 'Retention grace period in days (default: 30)')
  .option('--force, --all', 'Bypass grace period and prune all unreferenced packages immediately')
  .action(async (action: string = 'list', options: { dryRun?: boolean; days?: string | number; force?: boolean; all?: boolean }) => {
    // 'prune' is an alias for 'gc' (pnpm store prune parity)
    const act = action.toLowerCase() === 'prune' ? 'gc' : action.toLowerCase();

    if (act === 'path') {
      console.log(getStoreDir());
      return;
    }

    if (act === 'status') {
      const stored = listStore();
      const projects = getRegisteredProjects().filter(p => fs.existsSync(p));
      let totalSize = 0;
      let totalVersions = 0;
      for (const item of stored) {
        totalSize += item.totalSizeBytes;
        totalVersions += item.versions.length;
      }
      const grandTotalMb = (totalSize / (1024 * 1024)).toFixed(2);

      console.log(pc.bold('\n📦 Central Store Status:'));
      console.log(`  Location:         ${pc.cyan(getStoreDir())}`);
      console.log(`  Unique Packages:  ${pc.bold(stored.length.toString())}`);
      console.log(`  Package Versions: ${pc.bold(totalVersions.toString())}`);
      console.log(`  Total Disk Size:  ${pc.green(`${grandTotalMb} MB`)}`);
      console.log(`  Active Projects:  ${pc.bold(projects.length.toString())}`);
      return;
    }

    if (act === 'gc') {
      const dryRun = Boolean(options.dryRun);
      const force = Boolean(options.force || options.all);
      const retentionDays = options.days !== undefined ? Number(options.days) : (force ? 0 : 30);

      console.log(pc.bold(pc.blue('🧹 linkpm store gc:')) + (dryRun ? pc.yellow(' [DRY RUN]') : ''));
      console.log(pc.dim(`Scanning active projects, unmounted drives, and store packages (Grace Period: ${retentionDays} days)...`));

      const result = runGarbageCollection({ dryRun, retentionDays, force });
      const freedMb = (result.freedBytes / (1024 * 1024)).toFixed(2);

      console.log(`\n  Active Projects Tracked:    ${pc.bold(result.activeProjects.length.toString())}`);
      if (result.unmountedProjects.length > 0) {
        console.log(`  Unmounted Projects (Grace): ${pc.yellow(result.unmountedProjects.length.toString())}`);
      }
      console.log(`  Store Packages Scanned:     ${pc.bold(result.totalStorePackages.toString())}`);
      if (result.retainedGraceCount > 0) {
        console.log(`  Retained in Grace Period:   ${pc.cyan(result.retainedGraceCount.toString())}`);
      }

      if (result.prunedCount === 0) {
        console.log(pc.green('\n✨ Central store is clean. No expired unreferenced packages to prune.'));
      } else {
        const actionWord = dryRun ? 'Would prune' : 'Pruned';
        console.log(pc.bold(pc.green(`\n✔ ${actionWord} ${result.prunedCount} unreferenced package(s), freeing ${freedMb} MB.`)));
        for (const pkg of result.prunedPackages) {
          console.log(`  ${pc.dim('–')} ${pkg}`);
        }
      }
      return;
    }

    if (act === 'list') {
      const stored = listStore();
      console.log(pc.bold(`\n📦 Central Store: ${pc.dim(getStoreDir())}\n`));
      if (stored.length === 0) {
        console.log(pc.dim('  Store is currently empty.'));
        return;
      }

      let totalSize = 0;
      for (const item of stored) {
        totalSize += item.totalSizeBytes;
        const sizeMb = (item.totalSizeBytes / (1024 * 1024)).toFixed(2);
        console.log(
          `  ${pc.bold(item.name)} ${pc.dim(`(${item.versions.join(', ')})`)} - ${pc.cyan(`${sizeMb} MB`)}`
        );
      }
      const grandTotalMb = (totalSize / (1024 * 1024)).toFixed(2);
      console.log(pc.bold(pc.green(`\nTotal: ${stored.length} packages, ${grandTotalMb} MB stored.`)));
      return;
    }

    if (act === 'verify') {
      const fix = Boolean(options.force || (options as any).fix);
      console.log(pc.bold(pc.blue('🔍 linkpm store verify:')) + ' Verifying central store package integrity...');
      const res = await verifyStore({ fix });
      console.log(`  Packages Scanned:  ${pc.bold(res.totalScanned.toString())}`);
      if (res.tamperedCount === 0) {
        console.log(pc.bold(pc.green('\n✔ Store integrity verified. 0 tampered or corrupted packages found.\n')));
      } else {
        console.log(pc.bold(pc.red(`\n✖ Detected ${res.tamperedCount} tampered or corrupted package(s):`)));
        for (const t of res.tampered) {
          const status = t.fixed ? pc.green('[FIXED]') : pc.red('[CORRUPTED]');
          console.log(`  ${status} ${pc.bold(t.name)}@${t.version}: ${t.reason}`);
        }
        if (!fix) {
          console.log(pc.dim('\nRun "linkpm store verify --fix" to automatically restore corrupted packages from verified tarballs.\n'));
        } else {
          console.log(pc.bold(pc.green(`\n✔ Automatically repaired ${res.fixedCount} package(s).\n`)));
        }
      }
      return;
    }

    if (act === 'clear') {
      const res = await clearStore();
      console.log(pc.green(`✔ Cleared ${res.removedCount} packages from central store.`));
      return;
    }

    console.log(pc.yellow(`Unknown store action "${action}". Available: list, status, gc, verify, clear, path.`));
  });

// 8b. APPROVE-BUILDS COMMAND
cli
  .command('approve-builds', 'Inspect and approve package build scripts under default-deny policy')
  .option('-y, --yes', 'Automatically approve all detected build scripts without interactive prompt')
  .option('--all', 'Alias for --yes')
  .action(async (options: { yes?: boolean; all?: boolean }) => {
    const projectRoot = findProjectRoot();
    await runApproveBuilds(projectRoot, { yes: Boolean(options.yes || options.all), all: Boolean(options.all) });
  });

// 9. INIT COMMAND
cli
  .command('init', 'Initialize a new package.json for linkpm')
  .action(async () => {
    const projectRoot = process.cwd();
    const pkg = readPackageJson(projectRoot);
    writePackageJson(projectRoot, pkg);
    console.log(pc.green(`✔ Initialized package.json in ${projectRoot}`));
  });

// 10. DOCTOR COMMAND
cli
  .command('doctor', 'Perform environment and installation diagnostics')
  .option('--fix', 'Automatically repair detected issues such as IDE settings and path mappings')
  .action(async (options: { fix?: boolean }) => {
    const projectRoot = findProjectRoot();
    const checks = await runDoctor(projectRoot, { fix: options.fix });
    printDoctorResults(checks);
  });

// 11. TREE COMMAND
cli
  .command('tree', 'Display visual dependency tree of current project')
  .action(async () => {
    const projectRoot = findProjectRoot();
    const pkg = readPackageJson(projectRoot);
    const deps = pkg.dependencies || {};
    const devDeps = pkg.devDependencies || {};

    if (Object.keys(deps).length === 0 && Object.keys(devDeps).length === 0) {
      console.log(pc.yellow('No dependencies found in package.json to display.'));
      return;
    }

    console.log(pc.dim('Resolving dependency graph...'));
    const resolver = new DependencyResolver({ projectRoot, preferOffline: true });
    const { graph } = await resolver.resolve(deps, devDeps);
    console.log(pc.bold(`\n🌳 Dependency Tree for ${pc.cyan(pkg.name || 'project')}:\n`));
    console.log(graph.toTreeString());
    console.log('');
  });

// 12. WHY COMMAND
cli
  .command('why <package>', 'Explain why a package is in the dependency graph')
  .action(async (targetPackage: string) => {
    if (!targetPackage) {
      console.log(pc.yellow('Please specify a package name. Example: linkpm why lodash'));
      return;
    }
    const projectRoot = findProjectRoot();
    const pkg = readPackageJson(projectRoot);
    const deps = pkg.dependencies || {};
    const devDeps = pkg.devDependencies || {};

    console.log(pc.dim('Resolving dependency graph...'));
    const resolver = new DependencyResolver({ projectRoot, preferOffline: true });
    const { graph } = await resolver.resolve(deps, devDeps);
    const paths = graph.why(targetPackage);

    if (paths.length === 0) {
      console.log(pc.yellow(`Package "${targetPackage}" is not in the dependency graph.`));
      return;
    }

    console.log(pc.bold(`\n🔍 Found ${paths.length} dependency path(s) to ${pc.cyan(targetPackage)}:\n`));
    for (const p of paths) {
      console.log(`  ${p.join(pc.dim(' ➔ '))}`);
    }
    console.log('');
  });

// 13. RUN SCRIPT
cli
  .command('run <script> [...args]', 'Run an arbitrary package script')
  .option('-r, --recursive', 'Run the script across all workspace packages')
  .option('--filter <filter>', 'Filter workspace packages by name or pattern')
  .option('--if-present', 'Avoid exiting with non-zero code if script is not defined')
  .option('--ignore-scripts', 'Do not run scripts')
  .action(async (scriptName: string, args: string[] = [], options: { recursive?: boolean; filter?: string; ifPresent?: boolean; ignoreScripts?: boolean }) => {
    if (!scriptName) {
      console.log(pc.yellow('Please specify a script name. Example: linkpm run build'));
      return;
    }

    if (options.recursive || options.filter) {
      const exitCode = await runWorkspaceScript(scriptName, {
        filter: options.filter,
        ifPresent: options.ifPresent,
        extraArgs: Array.isArray(args) ? args : []
      });
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
      return;
    }

    const projectRoot = findProjectRoot();
    const res = await runScript(projectRoot, scriptName, {
      extraArgs: Array.isArray(args) ? args : [],
      ifPresent: options.ifPresent,
      ignoreScripts: options.ignoreScripts
    });
    if (!res.success) {
      process.exit(res.exitCode);
    }
  });

// 14. TEST SCRIPT ALIAS
cli
  .command('test [...args]', 'Run the test script from package.json')
  .action(async (args: string[] = []) => {
    const projectRoot = findProjectRoot();
    const res = await runScript(projectRoot, 'test', {
      extraArgs: Array.isArray(args) ? args : []
    });
    if (!res.success) {
      process.exit(res.exitCode);
    }
  });

// 15. START SCRIPT ALIAS
cli
  .command('start [...args]', 'Run the start script from package.json')
  .action(async (args: string[] = []) => {
    const projectRoot = findProjectRoot();
    const res = await runScript(projectRoot, 'start', {
      extraArgs: Array.isArray(args) ? args : []
    });
    if (!res.success) {
      process.exit(res.exitCode);
    }
  });

// 15b. DEV / BUILD SCRIPT SHORTHANDS (pnpm parity)
for (const scriptName of ['dev', 'build'] as const) {
  cli
    .command(`${scriptName} [...args]`, `Run the ${scriptName} script from package.json`)
    .action(async (args: string[] = []) => {
      const projectRoot = findProjectRoot();
      const res = await runScript(projectRoot, scriptName, {
        extraArgs: Array.isArray(args) ? args : []
      });
      if (!res.success) {
        process.exit(res.exitCode);
      }
    });
}

// 16. EXEC COMMAND
cli
  .command('exec <command> [...args]', 'Run a shell command within the project node_modules/.bin context')
  .action(async (command: string, args: string[] = []) => {
    if (!command) {
      console.log(pc.yellow('Please specify a command to execute.'));
      return;
    }
    const projectRoot = findProjectRoot();
    const code = execBin(projectRoot, command, Array.isArray(args) ? args : []);
    if (code !== 0) {
      process.exit(code);
    }
  });

// 17. DLX COMMAND
cli
  .command('dlx <package> [...args]', 'Run a command from an npm package without installing it as a dependency')
  .action(async (pkgSpec: string, args: string[] = []) => {
    if (!pkgSpec) {
      console.log(pc.yellow('Please specify a package to execute. Example: linkpm dlx cowsay hello'));
      return;
    }
    const code = await runDlx(pkgSpec, Array.isArray(args) ? args : []);
    if (code !== 0) {
      process.exit(code);
    }
  });

// 18. WORKSPACE COMMAND
cli
  .command('workspace [action]', 'Manage monorepo workspaces (list, link)')
  .alias('w')
  .option('--filter <filter>', 'Filter packages by name or pattern')
  .action(async (action: string = 'list', options: { filter?: string }) => {
    const rootConfig = findWorkspaceRoot();
    if (!rootConfig) {
      console.log(pc.yellow('No workspace configuration (pnpm-workspace.yaml or package.json workspaces) found.'));
      return;
    }
    const packages = discoverWorkspacePackages(rootConfig.root, rootConfig.globs);

    if (action === 'list') {
      console.log(pc.bold(`\n📦 Monorepo Workspaces (${pc.cyan(packages.length.toString())} packages found):\n`));
      for (const p of packages) {
        console.log(`  ${pc.bold(p.name)}@${pc.dim(p.version)} ${pc.dim(p.directory)}`);
      }
      console.log('');
      return;
    }

    if (action === 'link') {
      console.log(pc.bold('\n🔗 Linking workspace dependencies...'));
      const links = linkWorkspaceDependencies(packages);
      console.log(pc.green(`✔ Successfully linked ${links.length} inter-workspace dependencies.\n`));
      for (const l of links) {
        console.log(`  ${pc.cyan(l.sourcePackage)} -> ${pc.bold(l.targetPackage)}`);
      }
      console.log('');
      return;
    }

    console.log(pc.yellow(`Unknown workspace action "${action}". Available: list, link.`));
  });

// 19. OUTDATED COMMAND
cli
  .command('outdated', 'Check for newer versions of dependencies')
  .action(async () => {
    const projectRoot = findProjectRoot();
    console.log(pc.dim('Checking for outdated dependencies...'));
    const outdated = await checkOutdated(projectRoot);
    printOutdatedTable(outdated);
  });

// 19b. LIST / LS COMMAND (pnpm parity)
cli
  .command('list', 'List installed top-level packages and their resolved versions')
  .alias('ls')
  .action(async () => {
    const projectRoot = findProjectRoot();
    printInstalledList(projectRoot);
  });

// 20. AUDIT COMMAND
cli
  .command('audit', 'Run security audit on installed dependencies')
  .option('--format <format>', 'Output format: "text", "json", or "sarif" (default: "text")')
  .option('-o, --output <file>', 'Save audit report to file')
  .action(async (options: { format?: string; output?: string }) => {
    const projectRoot = findProjectRoot();
    const result = await runSecurityAudit(projectRoot);
    const fmt = (options.format || 'text').toLowerCase();

    if (fmt === 'sarif') {
      const sarifJson = formatSarifReport(result);
      if (options.output) {
        fs.writeFileSync(path.resolve(projectRoot, options.output), sarifJson + '\n', 'utf-8');
        console.log(pc.green(`✔ SARIF report written to ${options.output}`));
      } else {
        console.log(sarifJson);
      }
      return;
    }

    if (fmt === 'json') {
      const jsonStr = JSON.stringify(result, null, 2);
      if (options.output) {
        fs.writeFileSync(path.resolve(projectRoot, options.output), jsonStr + '\n', 'utf-8');
        console.log(pc.green(`✔ JSON report written to ${options.output}`));
      } else {
        console.log(jsonStr);
      }
      return;
    }

    printAuditResults(result);
  });

// 21. PATCH COMMAND
cli
  .command('patch <package>', 'Prepare a package for patching by extracting it to a temporary directory')
  .action(async (packageName: string) => {
    if (!packageName) {
      console.log(pc.yellow('Please specify a package name to patch. Example: linkpm patch lodash'));
      return;
    }
    const projectRoot = findProjectRoot();
    console.log(pc.bold(pc.blue('⚡ linkpm patch:')) + ` Preparing patch environment for ${pc.cyan(packageName)}...`);
    const { editDir } = await preparePatch(packageName, projectRoot);
    console.log(pc.bold(pc.green('\n✔ Package extracted successfully!')));
    console.log(`  Working directory: ${pc.cyan(editDir)}`);
    console.log(pc.dim('\nMake your code changes inside the directory above. Once done, commit your patch with:'));
    console.log(`  ${pc.bold(pc.cyan(`linkpm patch-commit "${editDir}"`))}\n`);
  });

// 22. PATCH-COMMIT COMMAND
cli
  .command('patch-commit <editDir>', 'Commit changes made to a patched package and generate a persistent .patch file')
  .action(async (editDir: string) => {
    if (!editDir) {
      console.log(pc.yellow('Please specify the directory containing your edits.'));
      return;
    }
    const projectRoot = findProjectRoot();
    console.log(pc.bold(pc.blue('⚡ linkpm patch-commit:')) + ` Committing patch from ${pc.dim(editDir)}...`);
    const { patchRelPath, packageKey } = await commitPatch(editDir, projectRoot);
    console.log(pc.bold(pc.green(`\n✔ Patch created at ${patchRelPath} and registered in package.json for ${packageKey}.`)));
    console.log(pc.dim('The patch has been applied directly to your active installation.\n'));
  });

// 23. AI COMMAND
cli
  .command('ai [action] [target]', 'Manage project AI capabilities (list, sync, add, remove)')
  .option('-y, --yes', 'Automatically confirm prompts without interactive questions')
  .action(async (action: string = 'list', target?: string, options: { yes?: boolean } = {}) => {
    const projectRoot = findProjectRoot();
    const act = action.toLowerCase();

    if (act === 'list' || act === 'ls') {
      const registry = readProjectAIRegistry(projectRoot);
      printAICapabilities(registry);
      return;
    }

    if (act === 'sync') {
      console.log(pc.bold(pc.blue('⚡ linkpm ai sync:')) + ' Scanning node_modules for AI capabilities and MCP servers...');
      const res = await scanAndSyncAllAICapabilities(projectRoot, { yes: Boolean(options.yes) });
      console.log(pc.green(`✔ Scanned ${res.packagesScanned} package(s). Found ${res.aiPackagesFound} AI-capable package(s).`));
      console.log(`  Active MCP Servers:  ${pc.bold(res.serversCount.toString())}`);
      console.log(`  Active Agent Skills: ${pc.bold(res.skillsCount.toString())}`);
      console.log(pc.dim('Synchronized to .cursor/mcp.json, mcp_config.json, and .agents/skills/\n'));
      return;
    }

    if (act === 'add') {
      if (!target) {
        console.log(pc.yellow('Please specify a package name to add. Example: linkpm ai add @modelcontextprotocol/server-postgres'));
        return;
      }
      console.log(pc.bold(pc.blue('⚡ linkpm ai add:')) + ` Installing ${pc.cyan(target)} and auto-wiring AI capabilities...`);
      await installPackages([target], projectRoot, { ai: true, yes: Boolean(options.yes) });
      const registry = readProjectAIRegistry(projectRoot);
      printAICapabilities(registry);
      return;
    }

    if (act === 'remove' || act === 'rm') {
      if (!target) {
        console.log(pc.yellow('Please specify a capability or package name to remove.'));
        return;
      }
      const res = removeAICapabilityFromConfigs(projectRoot, target);
      console.log(pc.green(`✔ Removed AI capability: ${target}`));
      if (res.removedServers.length > 0) console.log(`  Unregistered MCP servers: ${res.removedServers.join(', ')}`);
      if (res.removedSkills.length > 0) console.log(`  Unregistered skills: ${res.removedSkills.join(', ')}`);
      return;
    }

    console.log(pc.yellow(`Unknown AI action "${action}". Available: list, sync, add, remove.`));
  });

// 24. DEPLOY COMMAND (SERVERLESS & DOCKER FLATTENED PACKAGING)
cli
  .command('deploy', 'Package application with un-junctioned, flat node_modules for Serverless, Docker, and AWS Lambda')
  .alias('isolate')
  .option('--out <dir>', 'Output directory for standalone deployment bundle (default: dist-deploy)')
  .option('--prod', 'Include only production dependencies (default: true)')
  .action(async (options: { out?: string; prod?: boolean }) => {
    const projectRoot = findProjectRoot();
    console.log(pc.bold(pc.blue('⚡ linkpm deploy:')) + ` Packaging standalone bundle from ${pc.dim(projectRoot)}...`);
    const res = await deployProject(projectRoot, {
      outDir: options.out || 'dist-deploy',
      prod: options.prod !== false
    });
    const mbSize = (res.totalSize / (1024 * 1024)).toFixed(2);
    console.log(pc.bold(pc.green(`\n✔ Deployment package ready at: ${pc.cyan(res.outDir)}`)));
    console.log(`  Packaged Dependencies: ${pc.bold(res.packagesCount.toString())} (real, unlinked files)`);
    console.log(`  Bundle Size:           ${pc.bold(mbSize)} MB`);
    console.log(pc.dim('Ready to deploy to AWS Lambda, Vercel Serverless, Docker, or Google Cloud Run.\n'));
  });

// 25. IMPORT-LOCK COMMAND (ENTERPRISE DEPENDABOT / LOCKFILE SYNC)
cli
  .command('import-lock [file]', 'Import an external package-lock.json and synchronize linkpm-lock.json in lockstep')
  .alias('import-lockfile')
  .action(async (file?: string) => {
    const projectRoot = findProjectRoot();
    console.log(pc.bold(pc.blue('⚡ linkpm import-lock:')) + ` Synchronizing dependencies from lockfile...`);
    const res = importLockfile(projectRoot, file);
    console.log(pc.bold(pc.green(`\n✔ Successfully imported ${res.importedCount} locked package(s) from ${pc.cyan(res.lockfilePath)}.`)));
    console.log(pc.dim('Both linkpm-lock.json and package-lock.json are now in synchronized lockstep.\n'));
  });

// 26. EXPORT-LOCK COMMAND
cli
  .command('export-lock', 'Export and mirror standard npm package-lock.json (v3) from linkpm-lock.json')
  .alias('export-lockfile')
  .action(async () => {
    const projectRoot = findProjectRoot();
    const lock = readLockfile(projectRoot);
    if (!lock) {
      console.log(pc.yellow('No linkpm-lock.json found. Run "linkpm install" first.'));
      return;
    }
    syncNpmPackageLock(projectRoot, lock);
    console.log(pc.bold(pc.green('\n✔ Exported package-lock.json (v3) in sync with linkpm-lock.json.')));
    console.log(pc.dim('Ready for Dependabot, Snyk, and Vercel/Netlify CI builds.\n'));
  });

// 27. METRO-INIT COMMAND (REACT NATIVE ZERO-COPY METRO HELPER)
cli
  .command('metro-init', 'Inject zero-copy store watchFolders and symlink resolution into metro.config.js for React Native')
  .alias('metro')
  .action(async () => {
    const projectRoot = findProjectRoot();
    console.log(pc.bold(pc.blue('⚡ linkpm metro-init:')) + ` Configuring React Native Metro bundler...`);
    const res = initMetroConfig(projectRoot);
    if (res.created || res.updated) {
      console.log(pc.bold(pc.green(`\n✔ ${res.message}`)));
      console.log(`  Target File:  ${pc.cyan(res.filePath)}`);
      console.log(`  Store Folder: ${pc.cyan(res.storePath)}`);
      console.log(`  Symlinks:     ${pc.green('enabled (resolver.unstable_enableSymlinks = true)')}`);
      console.log(`  Node Modules: ${pc.green('mapped (resolver.nodeModulesPaths includes project node_modules)')}`);
      console.log(pc.dim('\nReact Native Metro bundler is now ready to resolve zero-copy store packages directly!\n'));
    } else {
      console.log(pc.cyan(`\nℹ ${res.message}`));
      console.log(`  Config File:  ${pc.dim(res.filePath)}`);
      console.log(`  Store Folder: ${pc.dim(res.storePath)}\n`);
    }
  });

// 27b. SELF-UPDATE COMMAND
cli
  .command('self-update', 'Update linkpm itself to the latest published version')
  .action(async () => {
    const current = getCliVersion();
    console.log(pc.bold(pc.blue('⚡ linkpm self-update:')) + pc.dim(` current version ${current}`));
    console.log(pc.dim('Fetching latest version from npm registry...'));

    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const res = spawnSync(npmCmd, ['install', '-g', 'linkpm@latest'], { stdio: 'inherit' });
    if (res.status === 0) {
      console.log(pc.bold(pc.green('\n✔ linkpm updated successfully.')));
      console.log(pc.dim('Restart your terminal (or re-run linkpm) to pick up the new version.\n'));
    } else {
      console.error(pc.red('\n✖ self-update failed. Try manually: npm i -g linkpm@latest\n'));
      process.exit(res.status ?? 1);
    }
  });

// 28. IDE-INIT COMMAND (VS CODE, CURSOR & TYPESCRIPT LANGUAGE SERVER LSP)
cli
  .command('ide-init', 'Auto-configure VS Code, Cursor, and TypeScript LSP settings for zero-copy store junctions')
  .alias('ide')
  .alias('vscode')
  .option('--plugin', 'Enable experimental linkpm-ts-plugin in tsconfig.json')
  .option('--diagnostics', 'Enable experimental background project diagnostics in VS Code')
  .action(async (options: { plugin?: boolean; diagnostics?: boolean }) => {
    const projectRoot = findProjectRoot();
    console.log(pc.bold(pc.blue('⚡ linkpm ide-init:')) + ` Optimizing IDE & TypeScript Language Server settings...`);
    const res = initIdeConfig(projectRoot, {
      enablePlugin: options.plugin,
      enableDiagnostics: options.diagnostics
    });
    console.log(pc.bold(pc.green(`\n✔ ${res.message}`)));
    console.log(`  VS Code Settings: ${pc.cyan(res.vscodePath)}`);
    console.log(`  TypeScript SDK:   ${pc.green('mapped (node_modules/typescript/lib)')}`);
    if (res.tsconfigPath) {
      console.log(`  TSConfig:         ${pc.cyan(res.tsconfigPath)} (preserveSymlinks = true)`);
    }
    console.log(pc.dim('\nVS Code, Cursor, and WebStorm will now follow store junctions seamlessly with full auto-completion and Go to Definition!\n'));
  });

const getCliVersion = (): string => {
  try {
    const pkgPath = new URL('../package.json', import.meta.url);
    const data = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return data.version || '1.0.3';
  } catch {
    return '1.0.3';
  }
};

cli.help();
cli.version(getCliVersion());

// git/npm-style update notifier: prints after the command completes (non-blocking)
scheduleUpdateNotice(getCliVersion());

cli.parse();
