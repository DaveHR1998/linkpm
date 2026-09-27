import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import semver from 'semver';
import { TARBALLS_DIR, getStoreDir, safePackageName } from './config.js';
import { parsePackageSpec as parseFullSpec } from './resolver/spec.js';
import { findWorkspaceRoot, resolveCatalogDependency } from './workspaces/config.js';

export interface PackageSpec {
  raw: string;
  name: string;
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
}

export interface ResolvedPackage {
  name: string;
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
    range: parsed.range,
    type: parsed.type,
    target: parsed.target
  };
}

function resolveFromLocalStore(name: string, range: string): ResolvedPackage | null {
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
  let range = parsed.range;

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
      throw new Error(`Cannot resolve catalog dependency "${name}@${range}" from workspace catalogs.`);
    }
  }

  // 3. Local paths: file: / link:
  if (parsed.type === 'file' || parsed.type === 'link') {
    const baseDir = options.projectRoot || process.cwd();
    const resolvedTarget = path.resolve(baseDir, parsed.target || parsed.range);

    if (!fs.existsSync(resolvedTarget)) {
      throw new Error(`Local dependency target not found: ${resolvedTarget}`);
    }

    // Check if it's a directory containing package.json
    const pkgJsonPath = path.join(resolvedTarget, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      const localName = pkgJson.name || name || path.basename(resolvedTarget);
      const localVersion = pkgJson.version || '1.0.0';

      return {
        name: localName,
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
      return {
        name: name || path.basename(resolvedTarget).replace(/\.(tgz|tar\.gz)$/, ''),
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
      version: '1.0.0',
      tarballUrl,
      tarballPath
    };
  }

  // 5. If offline or preferOffline, check local store first
  if (options.offline || options.preferOffline) {
    const local = resolveFromLocalStore(name, range);
    if (local) return local;
    if (options.offline) {
      throw new Error(`Package "${name}@${range}" is not available in local store and --offline mode is enabled.`);
    }
  }

  const encodedName = name.startsWith('@')
    ? `@${encodeURIComponent(name.slice(1))}`
    : encodeURIComponent(name);

  const registryUrl = `https://registry.npmjs.org/${encodedName}`;

  let response: Response;
  try {
    response = await fetch(registryUrl, {
      headers: {
        Accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*'
      }
    });
  } catch (err: any) {
    const local = resolveFromLocalStore(name, range);
    if (local) return local;
    throw new Error(`Failed to reach npm registry for "${name}": ${err.message}`);
  }

  if (!response.ok) {
    const local = resolveFromLocalStore(name, range);
    if (local) return local;
    throw new Error(`Failed to fetch metadata for "${name}" from npm registry (${response.status}: ${response.statusText})`);
  }

  const data = (await response.json()) as any;
  const versions = Object.keys(data.versions || {});

  let resolvedVersion = '';

  if (data['dist-tags'] && data['dist-tags'][range]) {
    resolvedVersion = data['dist-tags'][range];
  } else if (semver.valid(range)) {
    resolvedVersion = range;
  } else {
    const matched = semver.maxSatisfying(versions, range);
    if (matched) {
      resolvedVersion = matched;
    } else if (data['dist-tags']?.latest) {
      resolvedVersion = data['dist-tags'].latest;
    } else {
      throw new Error(`Could not resolve any version for "${name}" matching "${range}"`);
    }
  }

  const versionMeta = data.versions[resolvedVersion];
  if (!versionMeta) {
    throw new Error(`Package "${name}@${resolvedVersion}" not found in registry versions`);
  }

  const tarballUrl = versionMeta.dist?.tarball;
  if (!tarballUrl) {
    throw new Error(`No tarball URL found for "${name}@${resolvedVersion}"`);
  }

  const integrity = versionMeta.dist?.integrity;
  const safeName = safePackageName(name);
  const tarballFilename = `${safeName}-${resolvedVersion}.tgz`;
  const tarballPath = path.join(TARBALLS_DIR, tarballFilename);

  return {
    name,
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
