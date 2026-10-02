import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import semver from 'semver';
import { LINKPM_HOME } from './config/index.js';

interface UpdateCache {
  latestVersion: string;
  checkedAt: number;
}

const UPDATE_CHECK_FILE = path.join(LINKPM_HOME, 'update-check.json');
const CHECK_INTERVAL_MS = 6 * 3600 * 1000; // re-check at most every 6 hours

/** Commands that already touch the network — safe to piggy-back the check. */
const NETWORK_COMMANDS = new Set([
  'add', 'install', 'i', 'ci', 'use', 'update', 'upgrade', 'create',
  'dlx', 'audit', 'outdated', 'remove', 'rm', 'uninstall', 'preset'
]);

function readCache(): UpdateCache | null {
  try {
    if (!fs.existsSync(UPDATE_CHECK_FILE)) return null;
    return JSON.parse(fs.readFileSync(UPDATE_CHECK_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function writeCache(cache: UpdateCache): void {
  try {
    if (!fs.existsSync(LINKPM_HOME)) fs.mkdirSync(LINKPM_HOME, { recursive: true });
    fs.writeFileSync(UPDATE_CHECK_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  } catch {}
}

async function refreshLatestVersion(): Promise<void> {
  try {
    const res = await fetch('https://registry.npmjs.org/linkpm', {
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) return;
    const data = (await res.json()) as any;
    const latest = data?.['dist-tags']?.latest;
    if (latest && semver.valid(latest)) {
      writeCache({ latestVersion: latest, checkedAt: Date.now() });
    }
  } catch {
    // Offline / registry down — silently try again next run
  }
}

/**
 * git/npm-style update notifier:
 * - Prints a notice AFTER the command finishes (via process 'exit')
 * - Never blocks command execution; background refresh max once / 6h and only
 *   piggy-backed onto network-touching commands so short commands stay instant
 * - Disabled in CI, non-TTY, --help/--version, or LINKPM_NO_UPDATE_CHECK=1
 */
export function scheduleUpdateNotice(currentVersion: string): void {
  if (!process.stdout.isTTY) return;
  if (process.env.CI || process.env.LINKPM_NO_UPDATE_CHECK === '1' || process.env.LINKPM_NO_UPDATE_CHECK === 'true') return;
  const args = process.argv;
  if (args.includes('--help') || args.includes('-h') || args.includes('--version') || args.includes('-v')) return;

  const cache = readCache();

  if (cache && semver.valid(cache.latestVersion) && semver.valid(currentVersion) && semver.gt(cache.latestVersion, currentVersion)) {
    const latest = cache.latestVersion;
    process.on('exit', () => {
      process.stdout.write(
        `\n${pc.bgYellow(pc.black(' UPDATE AVAILABLE '))} ${pc.bold(`linkpm ${currentVersion}`)} → ${pc.bold(pc.green(latest))}\n` +
        `  Run ${pc.cyan('linkpm self-update')} or ${pc.cyan('npm i -g linkpm@latest')}\n\n`
      );
    });
  }

  const command = args[2] || '';
  const stale = !cache || Date.now() - (cache.checkedAt || 0) > CHECK_INTERVAL_MS;
  if (stale && NETWORK_COMMANDS.has(command)) {
    // Fire-and-forget; the process is going to be doing network I/O anyway
    void refreshLatestVersion();
  }
}
