import semver from 'semver';

export interface PlatformEnvironment {
  os: string;
  arch: string;
  nodeVersion: string;
}

export const CURRENT_PLATFORM: PlatformEnvironment = {
  os: process.platform,
  arch: process.arch,
  nodeVersion: process.version
};

function matchesPattern(current: string, patterns?: string[] | string): boolean {
  if (!patterns) return true;
  const list = Array.isArray(patterns) ? patterns : [patterns];
  if (list.length === 0) return true;

  // Check for negative patterns: e.g. "!win32"
  const hasNegation = list.some(p => p.startsWith('!'));
  if (hasNegation) {
    const isExcluded = list.some(p => p.startsWith('!') && p.slice(1).toLowerCase() === current.toLowerCase());
    if (isExcluded) return false;
  }

  const positivePatterns = list.filter(p => !p.startsWith('!'));
  if (positivePatterns.length === 0) {
    return true; // only negative patterns were specified, and none matched current
  }

  return positivePatterns.some(p => p.toLowerCase() === current.toLowerCase());
}

export function isPlatformSupported(
  meta: { os?: string[] | string; cpu?: string[] | string },
  env: PlatformEnvironment = CURRENT_PLATFORM
): boolean {
  // Check OS
  if (!matchesPattern(env.os, meta.os)) {
    return false;
  }

  // Check CPU Architecture
  if (!matchesPattern(env.arch, meta.cpu)) {
    return false;
  }

  return true;
}

export function isEngineSupported(
  engines?: Record<string, string>,
  env: PlatformEnvironment = CURRENT_PLATFORM
): { supported: boolean; reason?: string } {
  if (!engines || !engines.node) {
    return { supported: true };
  }

  const nodeRange = engines.node;
  const cleanVersion = semver.clean(env.nodeVersion) || env.nodeVersion;

  if (!semver.satisfies(cleanVersion, nodeRange)) {
    return {
      supported: false,
      reason: `Node.js version ${env.nodeVersion} does not satisfy package requirement "${nodeRange}"`
    };
  }

  return { supported: true };
}

export function shouldSkipOptionalPackage(
  pkgName: string,
  meta?: { os?: string[] | string; cpu?: string[] | string },
  env: PlatformEnvironment = CURRENT_PLATFORM
): boolean {
  // If explicit platform metadata exists, check it
  if (meta && (meta.os || meta.cpu)) {
    return !isPlatformSupported(meta, env);
  }

  // Common heuristic for prebuilt binary packages:
  // e.g. @rollup/rollup-linux-x64-gnu, esbuild-windows-64, etc.
  const nameLower = pkgName.toLowerCase();
  const knownOsList = ['darwin', 'linux', 'win32', 'windows', 'freebsd', 'openbsd', 'sunos', 'android'];
  const knownArchList = ['x64', 'arm64', 'arm', 'ia32', 's390x', 'ppc64'];

  const matchedOs = knownOsList.find(o => nameLower.includes(o));
  if (matchedOs) {
    const normalizedOs = matchedOs === 'windows' ? 'win32' : matchedOs;
    if (normalizedOs !== env.os) return true;
  }

  const matchedArch = knownArchList.find(a => nameLower.includes(a));
  if (matchedArch) {
    if (matchedArch !== env.arch) return true;
  }

  return false;
}
