import path from 'node:path';
import semver from 'semver';
import pc from 'picocolors';
import { readPackageJson } from '../package-json.js';
import { readLockfile } from '../lockfile/index.js';
import { RegistryClient } from '../registry/client.js';

export interface OutdatedEntry {
  packageName: string;
  current: string;
  wanted: string;
  latest: string;
  type: 'dependencies' | 'devDependencies';
}

export async function checkOutdated(projectRoot: string): Promise<OutdatedEntry[]> {
  const pkg = readPackageJson(projectRoot);
  const lock = readLockfile(projectRoot);
  const client = new RegistryClient();

  const allDeclared: Array<{ name: string; range: string; type: 'dependencies' | 'devDependencies' }> = [];

  if (pkg.dependencies) {
    for (const [name, range] of Object.entries(pkg.dependencies)) {
      allDeclared.push({ name, range, type: 'dependencies' });
    }
  }

  if (pkg.devDependencies) {
    for (const [name, range] of Object.entries(pkg.devDependencies)) {
      allDeclared.push({ name, range, type: 'devDependencies' });
    }
  }

  const outdated: OutdatedEntry[] = [];

  for (const dep of allDeclared) {
    // Determine currently installed version from lockfile or range
    let currentVersion = '0.0.0';
    if (lock) {
      for (const [key, pkgInfo] of Object.entries(lock.packages)) {
        if (key.startsWith(`${dep.name}@`)) {
          currentVersion = pkgInfo.version;
          break;
        }
      }
    }
    if (currentVersion === '0.0.0') {
      const minVer = semver.minVersion(dep.range);
      currentVersion = minVer ? minVer.version : dep.range;
    }

    try {
      const meta = await client.getPackageManifest(dep.name);
      const latest = meta['dist-tags']?.latest;
      if (!latest) continue;

      const allVersions = Object.keys(meta.versions || {});
      const cleanRange = dep.range.replace(/^[\^~]/, '');
      const wanted = semver.maxSatisfying(allVersions, dep.range) || currentVersion;

      if (semver.gt(latest, currentVersion) || semver.gt(wanted, currentVersion)) {
        outdated.push({
          packageName: dep.name,
          current: currentVersion,
          wanted,
          latest,
          type: dep.type
        });
      }
    } catch {
      // Ignore packages that cannot be reached or resolved
    }
  }

  return outdated;
}

export function printOutdatedTable(entries: OutdatedEntry[]): void {
  if (entries.length === 0) {
    console.log(pc.bold(pc.green('✔ All dependencies are up to date!')));
    return;
  }

  console.log(pc.bold('\nPackage'.padEnd(28) + 'Current'.padEnd(14) + 'Wanted'.padEnd(14) + 'Latest'.padEnd(14) + 'Type'));
  console.log(pc.dim('─'.repeat(80)));

  for (const item of entries) {
    const isMajor = semver.major(item.latest) > semver.major(item.current);
    const isMinor = semver.minor(item.latest) > semver.minor(item.current);

    const latestColor = isMajor ? pc.red : (isMinor ? pc.yellow : pc.green);
    const wantedColor = item.wanted !== item.current ? pc.green : pc.dim;

    const row =
      pc.bold(item.packageName.padEnd(28)) +
      pc.dim(item.current.padEnd(14)) +
      wantedColor(item.wanted.padEnd(14)) +
      latestColor(item.latest.padEnd(14)) +
      pc.dim(item.type);

    console.log(row);
  }

  console.log(pc.dim('─'.repeat(80)));
  console.log(pc.dim('Color legend: ') + pc.red('Red (major) ') + pc.yellow('Yellow (minor) ') + pc.green('Green (patch/wanted)\n'));
}
