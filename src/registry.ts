import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import semver from 'semver';
import { TARBALLS_DIR, STORE_DIR, safePackageName } from './config.js';

export interface PackageSpec {
  raw: string;
  name: string;
  range: string;
}

export interface ResolveOptions {
  offline?: boolean;
  preferOffline?: boolean;
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
}

export function parsePackageSpec(spec: string): PackageSpec {
  let name = spec.trim();
  let range = 'latest';

  if (spec.startsWith('@')) {
    // Scoped package e.g. @types/node@18.0.0
    const secondAt = spec.indexOf('@', 1);
    if (secondAt !== -1) {
      name = spec.slice(0, secondAt);
      range = spec.slice(secondAt + 1) || 'latest';
    }
  } else {
    // Unscoped package e.g. express@^4.18.0
    const firstAt = spec.indexOf('@');
    if (firstAt !== -1) {
      name = spec.slice(0, firstAt);
      range = spec.slice(firstAt + 1) || 'latest';
    }
  }

  return { raw: spec, name, range };
}

function resolveFromLocalStore(name: string, range: string): ResolvedPackage | null {
  const safeName = safePackageName(name);
  const pkgDir = path.join(STORE_DIR, safeName);
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
  const { name, range } = parsePackageSpec(spec);

  // If offline or preferOffline, check local store first
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
    // If network fails, try fallback to local store
    const local = resolveFromLocalStore(name, range);
    if (local) return local;
    throw new Error(`Failed to reach npm registry for "${name}": ${err.message}`);
  }

  if (!response.ok) {
    // Try local fallback on 404/500
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
