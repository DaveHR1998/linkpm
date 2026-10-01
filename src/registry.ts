import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import semver from 'semver';
import { TARBALLS_DIR, getStoreDir, safePackageName, loadNpmrc } from './config.js';
import { parsePackageSpec as parseFullSpec } from './resolver/spec.js';
import { findWorkspaceRoot, resolveCatalogDependency } from './workspaces/config.js';
import { discoverWorkspacePackages } from './workspaces/discovery.js';
import { RegistryClient, type PackageManifest } from './registry/client.js';
import { readLockfile } from './lockfile/index.js';
import { LinkPMError } from './utils/errors.js';

export interface PackageSpec {
  raw: string;
  name: string;
  /** The name to use when linking into node_modules (alias if given). */
  installName: string;
  range: string;
  type?: string;
  target?: string;
}

export interface ResolveOptions {
  offline?: boolean;
  preferOffline?: boolean;
  projectRoot?: string;
  overrides?: Record<string, string>;
  catalogs?: Record<string, Record<string, string>>;
  /** Bypass the minimum-release-age supply-chain cooldown. */
  ignoreReleaseAge?: boolean;
  /** Lockfile-pinned resolution preference (default: true when a lockfile exists). Pass false for `update`. */
  useLockfile?: boolean;
}

export interface ResolvedPackage {
  name: string;
  /** Alias-aware name used for node_modules linking and lockfile keys. */
  installName: string;
  version: string;
  tarballUrl: string;
  tarballPath: string;
  integrity?: string;
  bin?: Record<string, string> | string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  isLocal?: boolean;
  localPath?: string;
}

export function parsePackageSpec(spec: string): PackageSpec {
  const parsed = parseFullSpec(spec);
  return {
    raw: spec,
    name: parsed.name,
    installName: parsed.alias || parsed.name,
    range: parsed.range,
    type: parsed.type,
    target: parsed.target
  };
}

/**
 * Lazily-created RegistryClient instances keyed by project root so .npmrc
 * config (registry, scoped registries, auth tokens, mirrors) is honored for
 * every manifest request, including the install path.
 */
const registryClients = new Map<string, RegistryClient>();

function getRegistryClient(projectRoot?: string, full = false): RegistryClient {
  const key = `${projectRoot || ''}::${full ? 'full' : 'abbrev'}`;
  let client = registryClients.get(key);
  if (!client) {
    client = new RegistryClient({ projectRoot, fullMetadata: full });
    registryClients.set(key, client);
  }
  return client;
}

/** Primary entry for tests / cache invalidation. */
export function _resetRegistryClients(): void {
  registryClients.clear();
}

/**
 * Finds the highest lockfile-pinned version of `name` satisfying `range`,
 * giving deterministic installs for `linkpm install` without extra flags.
 */
function resolveFromLockfile(
  projectRoot: string | undefined,
  name: string,
  range: string
): { version: string; resolved: string; integrity?: string } | null {
  if (!projectRoot) return null;
  try {
    const lock = readLockfile(projectRoot);
    if (!lock || !lock.packages) return null;
    const candidates: { version: string; resolved: string; integrity?: string }[] = [];
    for (const [key, entry] of Object.entries(lock.packages)) {
      const atIdx = key.lastIndexOf('@');
      if (atIdx <= 0) continue;
      if (key.slice(0, atIdx) !== name) continue;
      if (semver.valid(entry.version) && semver.satisfies(entry.version, range, { includePrerelease: true })) {
        candidates.push({ version: entry.version, resolved: entry.resolved, integrity: entry.integrity });
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => semver.rcompare(a.version, b.version));
    return candidates[0];
  } catch {
    return null;
  }
}

/**
 * Selects a version from a registry manifest, honoring the
 * minimum-release-age cooldown (default 24h from .npmrc) used to mitigate
 * day-zero supply-chain attacks. Bypassed with --ignore-release-age or
 * release-age-exclude entries.
 */
export function matchVersionWithCooldown(
  name: string,
  range: string,
  manifest: PackageManifest,
  options: { minimumReleaseAgeSec?: number; releaseAgeExclude?: string[]; ignoreReleaseAge?: boolean } = {}
): string {
  const versions = Object.keys(manifest.versions || {});
  if (versions.length === 0) {
    throw new LinkPMError(`No published versions found for "${name}"`, {
      code: 'ERR_VERSION_NOT_FOUND',
      packageName: name
    });
  }

  const minAgeSec = options.ignoreReleaseAge ? 0 : Math.max(0, options.minimumReleaseAgeSec ?? 0);
  const minAgeMs = minAgeSec * 1000;
  const exclude = new Set(options.releaseAgeExclude || []);
  const enforceCooldown = minAgeMs > 0 && !exclude.has(name) && Boolean(manifest.time);

  const cooldownSafe = enforceCooldown
    ? versions.filter(v => {
        const published = manifest.time?.[v];
        if (!published) return true;
        return Date.now() - new Date(published).getTime() >= minAgeMs;
      })
    : versions;

  const distTagHit = manifest['dist-tags']?.[range];
  if (distTagHit && cooldownSafe.includes(distTagHit)) {
    return distTagHit;
  }

  if (semver.valid(range) && versions.includes(range)) {
    if (!cooldownSafe.includes(range)) {
      const pubTime = manifest.time?.[range];
      const ageHours = pubTime ? ((Date.now() - new Date(pubTime).getTime()) / 3600000).toFixed(1) : 'unknown';
      throw new LinkPMError(
        `Security Cooldown: "${name}@${range}" was published ${ageHours}h ago (minimum release age: ${(minAgeMs / 3600000).toFixed(0)}h)`,
        {
          code: 'ERR_VERSION_NOT_FOUND',
          packageName: name,
          requestedVersion: range,
          hint: `To install this package immediately, pass --ignore-release-age or add "${name}" to release-age-exclude in .npmrc.`
        }
      );
    }
    return range;
  }

  const matched = semver.maxSatisfying(cooldownSafe, range, { includePrerelease: true });
  if (matched) return matched;

  const unsafe = semver.maxSatisfying(versions, range, { includePrerelease: true });
  if (unsafe && enforceCooldown && !cooldownSafe.includes(unsafe)) {
    const pubTime = manifest.time?.[unsafe];
    const ageHours = pubTime ? ((Date.now() - new Date(pubTime).getTime()) / 3600000).toFixed(1) : 'unknown';
    throw new LinkPMError(
      `Security Cooldown: Latest satisfying version "${name}@${unsafe}" was published ${ageHours}h ago (minimum release age: ${(minAgeMs / 3600000).toFixed(0)}h)`,
      {
        code: 'ERR_VERSION_NOT_FOUND',
        packageName: name,
        requestedVersion: range,
        hint: `To install this release immediately, pass --ignore-release-age or add "${name}" to release-age-exclude in .npmrc.`
      }
    );
  }

  if (manifest['dist-tags']?.latest && cooldownSafe.includes(manifest['dist-tags']!.latest)) {
    return manifest['dist-tags']!.latest;
  }

  throw new LinkPMError(`No version of "${name}" satisfies range "${range}"`, {
    code: 'ERR_VERSION_NOT_FOUND',
    packageName: name,
    requestedVersion: range,
    hint: `Available versions: ${versions.slice(-5).join(', ')}`
  });
}

function resolveFromLocalStore(name: string, range: string, installName?: string): ResolvedPackage | null {
  const store = getStoreDir();
  const safeName = safePackageName(name);
  const pkgDir = path.join(store, safeName);
  if (!fs.existsSync(pkgDir)) return null;

  try {
    const versions = fs.readdirSync(pkgDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    if (versions.length === 0) return null;

    let matched: string | null = null;
    if (range === 'latest') {
      matched = semver.maxSatisfying(versions, '*');
    } else {
      matched = semver.maxSatisfying(versions, range);
    }

    if (!matched) return null;

    const matchedDir = path.join(pkgDir, matched);
    const pkgJsonPath = path.join(matchedDir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) return null;

    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    const tarballPath = path.join(TARBALLS_DIR, `${safeName}-${matched}.tgz`);

    return {
      name,
      installName: installName || name,
      version: matched,
      tarballUrl: '',
      tarballPath,
      bin: pkgJson.bin,
      dependencies: pkgJson.dependencies,
      devDependencies: pkgJson.devDependencies,
      peerDependencies: pkgJson.peerDependencies,
      optionalDependencies: pkgJson.optionalDependencies
    };
  } catch {
    return null;
  }
}

export async function resolvePackage(spec: string, options: ResolveOptions = {}): Promise<ResolvedPackage> {
  const parsed = parsePackageSpec(spec);
  let name = parsed.name;
  const installName = parsed.installName || name;
  let range = parsed.range;

  // The raw spec may be "<name>@workspace:*" which parses as a registry spec
  // with a workspace: range. Detect it here.
  const isWorkspaceSpec = parsed.type === 'workspace' || range.startsWith('workspace:');

  // 1. Check overrides
  if (options.overrides) {
    if (options.overrides[spec]) {
      range = options.overrides[spec];
    } else if (name && options.overrides[name]) {
      range = options.overrides[name];
    }
  }

  // 2. Resolve catalog specs
  if (range.startsWith('catalog:')) {
    const ws = findWorkspaceRoot(options.projectRoot);
    const catalogs = options.catalogs || ws?.catalogs || {};
    const resolvedCat = resolveCatalogDependency(range, name, catalogs);
    if (resolvedCat) {
      range = resolvedCat;
    } else {
      throw new LinkPMError(`Cannot resolve catalog dependency "${name}@${range}" from workspace catalogs.`, {
        code: 'ERR_VERSION_NOT_FOUND',
        packageName: name,
        hint: `Ensure "${name}" is declared under "catalog:" or "catalogs:" in pnpm-workspace.yaml.`
      });
    }
  }

  // 2a. Specs like "name@file:../dir" parse as registry specs with exotic ranges — normalize them here.
  if (parsed.type !== 'file' && parsed.type !== 'link' && (range.startsWith('file:') || range.startsWith('link:'))) {
    const targetStr = range.slice(range.indexOf(':') + 1);
    const baseDir = options.projectRoot || process.cwd();
    const resolvedTarget = path.resolve(baseDir, targetStr);

    if (!fs.existsSync(resolvedTarget)) {
      throw new LinkPMError(`Local dependency target not found: ${resolvedTarget}`, {
        code: 'ERR_PACKAGE_NOT_FOUND',
        packageName: name
      });
    }

    const pkgJsonPath = path.join(resolvedTarget, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      const localName = pkgJson.name || name || path.basename(resolvedTarget);
      return {
        name: localName,
        installName: installName || localName,
        version: pkgJson.version || '1.0.0',
        tarballUrl: `file://${resolvedTarget}`,
        tarballPath: resolvedTarget,
        bin: pkgJson.bin,
        dependencies: pkgJson.dependencies,
        devDependencies: pkgJson.devDependencies,
        peerDependencies: pkgJson.peerDependencies,
        optionalDependencies: pkgJson.optionalDependencies,
        isLocal: true,
        localPath: resolvedTarget
      };
    }

    if (resolvedTarget.endsWith('.tgz') || resolvedTarget.endsWith('.tar.gz')) {
      const tgzName = name || path.basename(resolvedTarget).replace(/\.(tgz|tar\.gz)$/, '');
      return {
        name: tgzName,
        installName: installName || tgzName,
        version: '1.0.0',
        tarballUrl: `file://${resolvedTarget}`,
        tarballPath: resolvedTarget,
        isLocal: true,
        localPath: resolvedTarget
      };
    }

    throw new LinkPMError(`Local dependency target "${resolvedTarget}" has no package.json.`, {
      code: 'ERR_PACKAGE_NOT_FOUND',
      packageName: name
    });
  }

  if (range.startsWith('git+') || range.startsWith('git://') || range.startsWith('github:')) {
    throw new LinkPMError(
      `Git dependency "${name}@${range}" cannot be fetched by the installer yet. LinkPM pins git commits during resolution but does not clone repositories.`,
      {
        code: 'ERR_REGISTRY_REQUEST',
        packageName: name,
        requestedVersion: range,
        hint: 'Vendor the dependency or publish it to your registry in the meantime.'
      }
    );
  }

  if (/^https?:\/\/\S+(?:\.tgz|\.tar\.gz)$/i.test(range)) {
    const tarballUrl = range;
    const baseName = name || path.basename(tarballUrl).replace(/\.(tgz|tar\.gz)$/, '');
    return {
      name: baseName,
      installName: installName || baseName,
      version: '1.0.0',
      tarballUrl,
      tarballPath: path.join(TARBALLS_DIR, `${safePackageName(baseName)}-remote.tgz`)
    };
  }

  // 2b. Workspace protocol: "workspace:*", "workspace:^" (or a workspace:* range)
  if (isWorkspaceSpec) {
    const wsConfig = findWorkspaceRoot(options.projectRoot);
    if (wsConfig) {
      const wsPackages = discoverWorkspacePackages(wsConfig.root, wsConfig.globs);
      const target = wsPackages.find(p => p.name === name);
      if (target) {
        return {
          name: target.name,
          installName,
          version: target.version,
          tarballUrl: `file://${target.directory}`,
          tarballPath: target.directory,
          bin: target.pkgJson.bin,
          dependencies: target.pkgJson.dependencies,
          devDependencies: target.pkgJson.devDependencies,
          peerDependencies: target.pkgJson.peerDependencies,
          optionalDependencies: target.pkgJson.optionalDependencies,
          isLocal: true,
          localPath: target.directory
        };
      }
    }
    throw new LinkPMError(`Workspace package "${name}" not found for spec "${spec}".`, {
      code: 'ERR_PACKAGE_NOT_FOUND',
      packageName: name,
      hint: 'Check that the workspace globs in pnpm-workspace.yaml or package.json "workspaces" cover this package.'
    });
  }

  // 3. Local paths: file: / link:
  if (parsed.type === 'file' || parsed.type === 'link') {
    const baseDir = options.projectRoot || process.cwd();
    const resolvedTarget = path.resolve(baseDir, parsed.target || parsed.range);

    if (!fs.existsSync(resolvedTarget)) {
      throw new LinkPMError(`Local dependency target not found: ${resolvedTarget}`, { code: 'ERR_PACKAGE_NOT_FOUND' });
    }

    // Check if it's a directory containing package.json
    const pkgJsonPath = path.join(resolvedTarget, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      const localName = pkgJson.name || name || path.basename(resolvedTarget);
      const localVersion = pkgJson.version || '1.0.0';

      return {
        name: localName,
        installName: installName || localName,
        version: localVersion,
        tarballUrl: `file://${resolvedTarget}`,
        tarballPath: resolvedTarget,
        bin: pkgJson.bin,
        dependencies: pkgJson.dependencies,
        devDependencies: pkgJson.devDependencies,
        peerDependencies: pkgJson.peerDependencies,
        optionalDependencies: pkgJson.optionalDependencies,
        isLocal: true,
        localPath: resolvedTarget
      };
    }

    // If it's a local tarball file
    if (resolvedTarget.endsWith('.tgz') || resolvedTarget.endsWith('.tar.gz')) {
      const tgzName = name || path.basename(resolvedTarget).replace(/\.(tgz|tar\.gz)$/, '');
      return {
        name: tgzName,
        installName: installName || tgzName,
        version: '1.0.0',
        tarballUrl: `file://${resolvedTarget}`,
        tarballPath: resolvedTarget,
        isLocal: true,
        localPath: resolvedTarget
      };
    }
  }

  // 4. Remote Tarball URL
  if (parsed.type === 'tarball' && parsed.target) {
    const tarballUrl = parsed.target;
    const safeName = safePackageName(name || path.basename(tarballUrl).replace(/\.(tgz|tar\.gz)$/, ''));
    const tarballPath = path.join(TARBALLS_DIR, `${safeName}-remote.tgz`);

    return {
      name: name || safeName,
      installName: installName || name || safeName,
      version: '1.0.0',
      tarballUrl,
      tarballPath
    };
  }

  // 5. Lockfile-pinned resolution: when a linkpm-lock.json exists and has a
  // satisfying version, prefer it for deterministic install/ci semantics.
  if (options.useLockfile !== false) {
    const locked = resolveFromLockfile(options.projectRoot, name, range);
    if (locked) {
      const safeNameLocked = safePackageName(name);
      return {
        name,
        installName,
        version: locked.version,
        tarballUrl: locked.resolved,
        tarballPath: path.join(TARBALLS_DIR, `${safeNameLocked}-${locked.version}.tgz`),
        integrity: locked.integrity
      };
    }
  }

  // 6. If offline or preferOffline, check local store first
  if (options.offline || options.preferOffline) {
    const local = resolveFromLocalStore(name, range, installName);
    if (local) return local;
    if (options.offline) {
      throw new LinkPMError(`Package "${name}@${range}" is not available in local store and --offline mode is enabled.`, {
        code: 'ERR_OFFLINE_NOT_CACHED',
        packageName: name
      });
    }
  }

  // 7. Registry metadata via RegistryClient — honors .npmrc registry, scoped
  // registries, auth tokens, mirrors, retries and on-disk metadata cache.
  const npmrc = loadNpmrc(options.projectRoot);
  const cooldownActive = !options.ignoreReleaseAge && (npmrc.minimumReleaseAge ?? 0) > 0;
  const client = getRegistryClient(options.projectRoot, cooldownActive);

  let manifest: PackageManifest;
  try {
    manifest = await client.getPackageManifest(name, {
      offline: options.offline,
      preferOffline: options.preferOffline
    });
  } catch (err: any) {
    const local = resolveFromLocalStore(name, range, installName);
    if (local) return local;
    throw err;
  }

  // 8. Pick version with release-age cooldown enforcement (default 24h).
  const resolvedVersion = matchVersionWithCooldown(name, range, manifest, {
    minimumReleaseAgeSec: npmrc.minimumReleaseAge,
    releaseAgeExclude: npmrc.releaseAgeExclude,
    ignoreReleaseAge: options.ignoreReleaseAge
  });

  const versionMeta = manifest.versions[resolvedVersion];
  if (!versionMeta) {
    throw new LinkPMError(`Package "${name}@${resolvedVersion}" not found in registry versions`, {
      code: 'ERR_VERSION_NOT_FOUND',
      packageName: name
    });
  }

  const tarballUrl = versionMeta.dist?.tarball;
  if (!tarballUrl) {
    throw new LinkPMError(`No tarball URL found for "${name}@${resolvedVersion}"`, {
      code: 'ERR_REGISTRY_REQUEST',
      packageName: name,
      requestedVersion: range
    });
  }

  const integrity = versionMeta.dist?.integrity;
  const safeName = safePackageName(name);
  const tarballPath = path.join(TARBALLS_DIR, `${safeName}-${resolvedVersion}.tgz`);

  return {
    name,
    installName,
    version: resolvedVersion,
    tarballUrl,
    tarballPath,
    integrity,
    bin: versionMeta.bin,
    dependencies: versionMeta.dependencies,
    devDependencies: versionMeta.devDependencies,
    peerDependencies: versionMeta.peerDependencies,
    optionalDependencies: versionMeta.optionalDependencies
  };
}

export async function downloadTarball(pkg: ResolvedPackage): Promise<string> {
  if (fs.existsSync(pkg.tarballPath)) {
    return pkg.tarballPath;
  }

  if (pkg.tarballUrl.startsWith('file://')) {
    const localPath = pkg.tarballUrl.slice(7);
    if (fs.existsSync(localPath)) {
      return localPath;
    }
  }

  if (!pkg.tarballUrl || !pkg.tarballUrl.startsWith('http')) {
    throw new Error(`Cannot download tarball for "${pkg.name}": invalid tarball URL "${pkg.tarballUrl}"`);
  }

  if (!fs.existsSync(TARBALLS_DIR)) {
    fs.mkdirSync(TARBALLS_DIR, { recursive: true });
  }

  const res = await fetch(pkg.tarballUrl);
  if (!res.ok) {
    throw new Error(`Failed to download tarball from ${pkg.tarballUrl} (${res.status})`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());

  // Verify SHA-512 integrity checksum if provided
  if (pkg.integrity && pkg.integrity.startsWith('sha512-')) {
    const expectedHash = pkg.integrity.slice(7);
    const actualHash = crypto.createHash('sha512').update(buffer).digest('base64');
    if (actualHash !== expectedHash) {
      throw new Error(
        `Integrity check failed for "${pkg.name}@${pkg.version}"!\n  Expected: sha512-${expectedHash}\n  Actual:   sha512-${actualHash}`
      );
    }
  }

  fs.writeFileSync(pkg.tarballPath, buffer);
  return pkg.tarballPath;
}
