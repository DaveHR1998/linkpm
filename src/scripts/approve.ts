import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import pc from 'picocolors';
import { readPackageJson, getOnlyBuiltDependencies, addOnlyBuiltDependencies } from '../package-json.js';
import { readLockfile } from '../lockfile/index.js';
import { getPackageStoreDir, markStoreDirectoryWritable, markStoreDirectoryReadOnly, runLifecycleScripts } from '../store/index.js';

export interface PendingBuildScript {
  name: string;
  version: string;
  storeDir: string;
  scriptType: string;
  scriptCommand: string;
}

export interface ApproveBuildsOptions {
  yes?: boolean;
  all?: boolean;
  interactive?: boolean;
}

/**
 * Discovers installed packages that define install, preinstall, or postinstall scripts.
 */
export function findPendingBuildScripts(projectRoot: string): PendingBuildScript[] {
  const onlyBuilt = new Set<string>(getOnlyBuiltDependencies(projectRoot) || []);
  const lock = readLockfile(projectRoot);
  const pending: PendingBuildScript[] = [];

  const checkPackageDir = (name: string, version: string, dir: string) => {
    const baseName = name.startsWith('@') ? name.split('/')[1] : name;
    if (onlyBuilt.has(name) || onlyBuilt.has(baseName)) {
      return; // Already approved
    }

    const pkgJsonPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) return;

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      const scripts = pkg.scripts || {};
      const scriptType = scripts.install ? 'install' : (scripts.postinstall ? 'postinstall' : (scripts.preinstall ? 'preinstall' : null));
      if (scriptType && scripts[scriptType]) {
        pending.push({
          name,
          version,
          storeDir: dir,
          scriptType,
          scriptCommand: scripts[scriptType]
        });
      }
    } catch {}
  };

  if (lock && lock.packages) {
    for (const [key, pkgInfo] of Object.entries(lock.packages)) {
      const atIdx = key.lastIndexOf('@');
      const name = atIdx > 0 ? key.slice(0, atIdx) : key;
      const version = pkgInfo.version;
      const storeDir = getPackageStoreDir(name, version);
      if (fs.existsSync(storeDir)) {
        checkPackageDir(name, version, storeDir);
      }
    }
  } else {
    // Fallback: scan node_modules
    const nm = path.join(projectRoot, 'node_modules');
    if (fs.existsSync(nm)) {
      const entries = fs.readdirSync(nm, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'linkpm-lock.json') continue;
        if (entry.name.startsWith('@')) {
          const scopeDir = path.join(nm, entry.name);
          const scopedEntries = fs.readdirSync(scopeDir, { withFileTypes: true });
          for (const s of scopedEntries) {
            const fullName = `${entry.name}/${s.name}`;
            const pkgDir = path.join(scopeDir, s.name);
            checkPackageDir(fullName, 'unknown', pkgDir);
          }
        } else {
          checkPackageDir(entry.name, 'unknown', path.join(nm, entry.name));
        }
      }
    }
  }

  return pending;
}

/**
 * Interactive or automated command to approve build scripts and execute them.
 */
export async function runApproveBuilds(
  projectRoot: string,
  options: ApproveBuildsOptions = {}
): Promise<{ approved: string[]; executed: number }> {
  const pending = findPendingBuildScripts(projectRoot);

  if (pending.length === 0) {
    console.log(pc.green('\n✔ No unapproved build scripts found. All installed packages are safe and verified.'));
    return { approved: [], executed: 0 };
  }

  console.log(pc.bold(pc.yellow(`\n⚠️  Build Scripts Approval Required (${pending.length} package(s))`)));
  console.log(pc.dim('Under LinkPM default-deny security, package build scripts do NOT run automatically.'));
  console.log(pc.dim('Review the scripts below before permitting them to execute:\n'));

  for (const item of pending) {
    console.log(`  • ${pc.bold(pc.cyan(item.name))}${pc.dim(`@${item.version}`)}`);
    console.log(`    ${pc.dim(item.scriptType + ':')} ${pc.yellow(item.scriptCommand)}`);
  }

  const autoApprove = options.yes || options.all;
  let shouldApprove = false;

  if (autoApprove) {
    shouldApprove = true;
  } else {
    const isTTY = Boolean(process.stdin.isTTY && !process.env.CI);
    if (!isTTY || options.interactive === false) {
      console.warn(
        pc.yellow(
          '\n⚠️  Cannot prompt interactively in non-interactive environment.\n' +
          '   Pass --yes (-y) to approve all detected build scripts in CI or automated environments.\n'
        )
      );
      return { approved: [], executed: 0 };
    }

    const rl = readline.createInterface({ input, output });
    try {
      const answer = await rl.question(pc.bold('\nApprove these packages to run build scripts and add to package.json? [y/N]: '));
      const normalized = answer.trim().toLowerCase();
      shouldApprove = normalized === 'y' || normalized === 'yes';
    } finally {
      rl.close();
    }
  }

  if (!shouldApprove) {
    console.log(pc.yellow('\n✖ Build script execution declined. Packages remain installed without running scripts.'));
    return { approved: [], executed: 0 };
  }

  const namesToApprove = pending.map(p => p.name);
  addOnlyBuiltDependencies(projectRoot, namesToApprove);
  console.log(pc.green(`\n✔ Added ${namesToApprove.length} package(s) to "onlyBuiltDependencies" in package.json.`));

  // Execute build scripts for approved packages
  let executed = 0;
  for (const item of pending) {
    console.log(`  ${pc.bold(pc.blue('⚡ Building'))} ${pc.bold(item.name)}...`);
    try {
      markStoreDirectoryWritable(item.storeDir);
      runLifecycleScripts(item.storeDir, {
        allowAllScripts: true
      });
      markStoreDirectoryReadOnly(item.storeDir);
      executed++;
    } catch (err: any) {
      console.error(pc.red(`  ✖ Build failed for ${item.name}: ${err.message}`));
    }
  }

  console.log(pc.bold(pc.green(`\n✔ Completed build scripts for ${executed} package(s).\n`)));
  return { approved: namesToApprove, executed };
}

export const findUnapprovedBuiltDependencies = findPendingBuildScripts;

export function approveBuiltDependencies(projectRoot: string, packages: string[]): void {
  addOnlyBuiltDependencies(projectRoot, packages);
}

