import fs from 'node:fs';
import path from 'node:path';
import {
  METADATA_CACHE_DIR,
  safePackageName,
  loadNpmrc,
  getRegistryForPackage,
  getAuthHeaderForRegistry,
  type NpmrcConfig
} from '../config/index.js';
import { LinkPMError } from '../utils/errors.js';

export interface PackageVersionMetadata {
  name: string;
  version: string;
  dist: {
    tarball: string;
    shasum?: string;
    integrity?: string;
  };
  bin?: Record<string, string> | string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  optionalDependencies?: Record<string, string>;
  bundledDependencies?: string[];
  os?: string[] | string;
  cpu?: string[] | string;
  engines?: Record<string, string>;
}

export interface PackageManifest {
  name: string;
  'dist-tags': Record<string, string>;
  versions: Record<string, PackageVersionMetadata>;
  time?: Record<string, string>;
}

export interface RegistryClientOptions {
  projectRoot?: string;
  offline?: boolean;
  preferOffline?: boolean;
  maxRetries?: number;
  timeoutMs?: number;
  /** Request the full packument (includes per-version publish times) instead of abbreviated metadata. */
  fullMetadata?: boolean;
}

export class RegistryClient {
  private npmrc: NpmrcConfig;
  private memoryCache: Map<string, PackageManifest> = new Map();
  private maxRetries: number;
  private timeoutMs: number;
  private fullMetadata: boolean;

  constructor(options: RegistryClientOptions = {}) {
    this.npmrc = loadNpmrc(options.projectRoot);
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.fullMetadata = Boolean(options.fullMetadata);
  }

  public async getPackageManifest(
    packageName: string,
    options: { offline?: boolean; preferOffline?: boolean } = {}
  ): Promise<PackageManifest> {
    // 1. In-memory cache
    if (this.memoryCache.has(packageName)) {
      return this.memoryCache.get(packageName)!;
    }

    // 2. Disk metadata cache (~/.linkpm/metadata-cache/)
    const diskCached = this.readDiskCache(packageName);
    if (diskCached) {
      if (options.offline || options.preferOffline) {
        this.memoryCache.set(packageName, diskCached);
        return diskCached;
      }
    }

    if (options.offline) {
      if (diskCached) return diskCached;
      throw new LinkPMError(`Package "${packageName}" is not cached locally and --offline is enabled.`, {
        code: 'ERR_OFFLINE_NOT_CACHED',
        packageName,
        hint: 'Run without --offline to allow LinkPM to fetch metadata from the registry.'
      });
    }

    // 3. Network fetch with retry & exponential backoff
    const registryUrl = getRegistryForPackage(packageName, this.npmrc);
    const encodedName = packageName.startsWith('@')
      ? `@${encodeURIComponent(packageName.slice(1))}`
      : encodeURIComponent(packageName);

    const fullUrl = `${registryUrl}${encodedName}`;
    const authHeader = getAuthHeaderForRegistry(registryUrl, this.npmrc);

    const headers: Record<string, string> = {
      Accept: this.getAcceptHeader()
    };
    if (authHeader) {
      headers['Authorization'] = authHeader;
    }

    let manifest: PackageManifest | null = null;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        let reqHeaders = { ...headers };
        let currentUrl = fullUrl;
        let res = await fetch(currentUrl, {
          headers: reqHeaders,
          signal: controller.signal,
          redirect: 'manual'
        });

        // Strip Authorization header if redirected to an external host (e.g. S3 / CDN)
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          const redirectLocation = new URL(res.headers.get('location')!, currentUrl);
          const origHost = new URL(currentUrl).host;
          if (redirectLocation.host !== origHost) {
            delete reqHeaders['Authorization'];
          }
          res = await fetch(redirectLocation.toString(), {
            headers: reqHeaders,
            signal: controller.signal
          });
        }
        clearTimeout(timer);

        if (res.status === 404) {
          throw new LinkPMError(`Package "${packageName}" not found in registry (${registryUrl})`, {
            code: 'ERR_PACKAGE_NOT_FOUND',
            packageName,
            hint: 'Verify the package name spelling and ensure you have access if it is private.'
          });
        }

        if (!res.ok) {
          // Retry on 429 or 5xx server errors
          if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
            const delay = Math.pow(2, attempt) * 300;
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          throw new LinkPMError(`Registry returned HTTP ${res.status}: ${res.statusText}`, {
            code: 'ERR_REGISTRY_REQUEST',
            packageName,
            hint: `Registry URL: ${fullUrl}`
          });
        }

        manifest = (await res.json()) as PackageManifest;
        break;
      } catch (err: any) {
        lastError = err;
        if (err.name === 'AbortError') {
          lastError = new LinkPMError(`Request timed out after ${this.timeoutMs}ms for "${packageName}"`, {
            code: 'ERR_REGISTRY_REQUEST',
            packageName,
            hint: 'Check your internet connection or registry proxy settings.'
          });
        }
        if (err instanceof LinkPMError && err.code === 'ERR_PACKAGE_NOT_FOUND') {
          throw err;
        }
        if (attempt < this.maxRetries) {
          const delay = Math.pow(2, attempt) * 300;
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    if (!manifest) {
      if (diskCached) {
        // Fallback to stale cache if network failed
        this.memoryCache.set(packageName, diskCached);
        return diskCached;
      }
      throw lastError || new LinkPMError(`Failed to fetch metadata for "${packageName}"`, {
        code: 'ERR_REGISTRY_REQUEST',
        packageName
      });
    }

    // Cache manifest
    this.memoryCache.set(packageName, manifest);
    this.writeDiskCache(packageName, manifest);

    return manifest;
  }

  private getAcceptHeader(): string {
    return this.fullMetadata
      ? 'application/json'
      : 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*';
  }

  private getDiskCachePath(packageName: string): string {
    const safeName = safePackageName(packageName);
    const suffix = this.fullMetadata ? '.full.json' : '.json';
    return path.join(METADATA_CACHE_DIR, `${safeName}${suffix}`);
  }

  private readDiskCache(packageName: string): PackageManifest | null {
    try {
      const filePath = this.getDiskCachePath(packageName);
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private writeDiskCache(packageName: string, manifest: PackageManifest): void {
    try {
      if (!fs.existsSync(METADATA_CACHE_DIR)) {
        fs.mkdirSync(METADATA_CACHE_DIR, { recursive: true });
      }
      const filePath = this.getDiskCachePath(packageName);
      fs.writeFileSync(filePath, JSON.stringify(manifest), 'utf-8');
    } catch {}
  }
}
