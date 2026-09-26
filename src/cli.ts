import fs from 'node:fs';
import { cac } from 'cac';
import pc from 'picocolors';
import { ensureDirectories, STORE_DIR } from './config/index.js';
import { findProjectRoot, writePackageJson, readPackageJson } from './package-json.js';
import {
  installPackages,
  installPreset,
  installProjectDependencies,
  uninstallPackages,
  installFromLockfile
} from './installer.js';
import { listPresets, findPreset, saveCustomPreset, removeCustomPreset } from './presets.js';
import { listStore, clearStore, runGarbageCollection, getRegisteredProjects } from './store.js';
import { scaffoldProject } from './scaffolder.js';
import { runDoctor, printDoctorResults } from './diagnostics/doctor.js';
import { DependencyResolver } from './resolver/index.js';
import { runScript, execBin, runDlx } from './scripts/index.js';

const cli = cac('linkpm');

ensureDirectories();

// 0. CREATE / SCAFFOLD COMMAND
cli
  .command('create <template> [projectName]', 'Create a complete ready-to-run project (frontend, backend, fastify)')
  .action(async (template: string, projectName: string) => {
    try {
      await scaffoldProject(template, projectName);
    } catch (err: any) {
      console.error(pc.red(`\n✖ Error: ${err.message}`));
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
  .action(async (packages: string[], options: { dev?: boolean; preset?: string; offline?: boolean; preferOffline?: boolean }) => {
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
  .action(async (packages: string[]) => {
    if (!packages || packages.length === 0) {
      console.log(pc.yellow('Please specify at least one package to remove.'));
      console.log(pc.dim('Example: linkpm remove lodash axios'));
      return;
    }

    const projectRoot = findProjectRoot();
    console.log(pc.bold(pc.blue('⚡ linkpm remove:')) + pc.dim(` Removing packages from ${projectRoot}\n`));
    await uninstallPackages(packages, projectRoot);
  });

// 4. INSTALL / I COMMAND
cli
  .command('install', 'Install all dependencies from package.json')
  .alias('i')
  .option('--offline', 'Force offline mode (use only cached packages)')
  .option('--prefer-offline', 'Prefer cached packages in store if available')
  .action(async (options: { offline?: boolean; preferOffline?: boolean }) => {
    const projectRoot = findProjectRoot();
    console.log(pc.bold(pc.blue('⚡ linkpm')) + pc.dim(` installing dependencies in ${projectRoot}`));
    await installProjectDependencies(projectRoot, options);
    console.log(pc.green('\n✨ Done! All dependencies linked from central store.'));
  });

// 5. CI (CLEAN INSTALL FROM LOCKFILE)
cli
  .command('ci', 'Install exact locked dependencies from linkpm-lock.json')
  .option('--offline', 'Force offline mode')
  .action(async (options: { offline?: boolean }) => {
    const projectRoot = findProjectRoot();
    try {
      await installFromLockfile(projectRoot, options);
      console.log(pc.green('\n✨ Done! All locked dependencies linked successfully.'));
    } catch (err: any) {
      console.error(pc.red(`\n✖ Error: ${err.message}`));
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
    await installPackages(specs, projectRoot, { preferOffline: false });
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
  .command('store [action]', 'Manage central store (list, status, gc, clear, path)')
  .option('--dry-run', 'Simulate garbage collection without deleting any files')
  .action(async (action: string = 'list', options: { dryRun?: boolean }) => {
    const act = action.toLowerCase();

    if (act === 'path') {
      console.log(STORE_DIR);
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
      console.log(`  Location:         ${pc.cyan(STORE_DIR)}`);
      console.log(`  Unique Packages:  ${pc.bold(stored.length.toString())}`);
      console.log(`  Package Versions: ${pc.bold(totalVersions.toString())}`);
      console.log(`  Total Disk Size:  ${pc.green(`${grandTotalMb} MB`)}`);
      console.log(`  Active Projects:  ${pc.bold(projects.length.toString())}`);
      return;
    }

    if (act === 'gc') {
      const dryRun = Boolean(options.dryRun);
      console.log(pc.bold(pc.blue('🧹 linkpm store gc:')) + (dryRun ? pc.yellow(' [DRY RUN]') : ''));
      console.log(pc.dim('Scanning active projects and unused store packages...'));

      const result = runGarbageCollection({ dryRun });
      const freedMb = (result.freedBytes / (1024 * 1024)).toFixed(2);

      console.log(`\n  Active Projects Tracked: ${pc.bold(result.activeProjects.length.toString())}`);
      console.log(`  Store Packages Scanned:  ${pc.bold(result.totalStorePackages.toString())}`);

      if (result.prunedCount === 0) {
        console.log(pc.green('\n✨ Central store is clean. No unreferenced packages to prune.'));
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
      console.log(pc.bold(`\n📦 Central Store: ${pc.dim(STORE_DIR)}\n`));
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

    if (act === 'clear') {
      const res = await clearStore();
      console.log(pc.green(`✔ Cleared ${res.removedCount} packages from central store.`));
      return;
    }

    console.log(pc.yellow(`Unknown store action "${action}". Available: list, status, gc, clear, path.`));
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
  .action(async () => {
    const projectRoot = findProjectRoot();
    const checks = await runDoctor(projectRoot);
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
  .option('--if-present', 'Avoid exiting with non-zero code if script is not defined')
  .option('--ignore-scripts', 'Do not run scripts')
  .action(async (scriptName: string, args: string[] = [], options: { ifPresent?: boolean; ignoreScripts?: boolean }) => {
    if (!scriptName) {
      console.log(pc.yellow('Please specify a script name. Example: linkpm run build'));
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

cli.help();
cli.version('1.0.1');

cli.parse();
