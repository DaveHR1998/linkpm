import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import { execSync } from 'node:child_process';
import { RegistryClient, type PackageVersionMetadata } from '../registry/client.js';
import { DependencyGraph, type DependencyNode } from '../graph/index.js';
import { parsePackageSpec } from './spec.js';
import { shouldSkipOptionalPackage } from './platform.js';
import { PeerEngine, type PeerValidationResult } from './peer.js';
import { LinkPMError } from '../utils/errors.js';
import { findWorkspaceRoot, resolveCatalogDependency } from '../workspaces/config.js';
import { loadNpmrc } from '../config/index.js';

export * from './spec.js';
export * from './platform.js';
export * from './peer.js';

export interface ResolveOptions {
  projectRoot?: string;
  offline?: boolean;
  preferOffline?: boolean;
  overrides?: Record<string, string>;
  strictPeers?: boolean;
  catalogs?: Record<string, Record<string, string>>;
  minimumReleaseAge?: number;
  releaseAgeExclude?: string[];
  ignoreReleaseAge?: boolean;
  allowExoticTransitive?: boolean;
}

export interface ResolveResult {
  graph: DependencyGraph;
  peerResult: PeerValidationResult;
  totalResolved: number;
}

export class DependencyResolver {
  private registryClient: RegistryClient;
  private defaultOptions: ResolveOptions;
  private overrides: Record<string, string>;

  constructor(options: ResolveOptions = {}) {
    const npmrc = loadNpmrc(options.projectRoot);
    this.defaultOptions = {
      minimumReleaseAge: npmrc.minimumReleaseAge,
      releaseAgeExclude: npmrc.releaseAgeExclude,
      allowExoticTransitive: npmrc.allowExoticTransitive,
      ...options
    };
    this.registryClient = new RegistryClient({
      projectRoot: options.projectRoot,
      offline: options.offline,
      preferOffline: options.preferOffline ?? true
    });
    this.overrides = options.overrides || {};
  }

  public async resolve(
    rootDependencies: Record<string, string> = {},
    rootDevDependencies: Record<string, string> = {},
    options: ResolveOptions = {}
  ): Promise<ResolveResult> {
    const mergedOptions: ResolveOptions = {
      preferOffline: true,
      ...this.defaultOptions,
      ...options
    };

    const graph = new DependencyGraph();
    const visitedSpecs = new Map<string, string>(); // "name@range" -> nodeId
    const queue: Array<{
      requestedName: string;
      rawRange: string;
      isDev: boolean;
      isOptional: boolean;
      parentId?: string;
    }> = [];

    // 1. Enqueue direct dependencies
    for (const [depName, range] of Object.entries(rootDependencies)) {
      queue.push({
        requestedName: depName,
        rawRange: range,
        isDev: false,
        isOptional: false
      });
    }

    // 2. Enqueue dev dependencies
    for (const [depName, range] of Object.entries(rootDevDependencies)) {
      queue.push({
        requestedName: depName,
        rawRange: range,
        isDev: true,
        isOptional: false
      });
    }

    // 3. Process breadth-first
    while (queue.length > 0) {
      const item = queue.shift()!;
      let { requestedName, rawRange, isDev, isOptional, parentId } = item;

      // Resolve catalog spec if present (e.g. "catalog:", "catalog:react18")
      if (rawRange.startsWith('catalog:')) {
        const workspaceConfig = findWorkspaceRoot(mergedOptions.projectRoot);
        const catalogs = mergedOptions.catalogs || workspaceConfig?.catalogs || {};
        const resolvedCatalog = resolveCatalogDependency(rawRange, requestedName, catalogs);
        if (resolvedCatalog) {
          rawRange = resolvedCatalog;
        } else {
          throw new LinkPMError(`Cannot resolve catalog dependency "${requestedName}@${rawRange}"`, {
            code: 'ERR_VERSION_NOT_FOUND',
            packageName: requestedName,
            requestedVersion: rawRange,
            hint: `Ensure "${requestedName}" is declared under "catalog:" or "catalogs:" in pnpm-workspace.yaml.`
          });
        }
      }

      // Apply overrides if present
      if (this.overrides[requestedName]) {
        rawRange = this.overrides[requestedName];
      }

      // Parse spec (handles aliases like "my-react@npm:react@^18.0.0")
      const parsed = parsePackageSpec(`${requestedName}@${rawRange}`);
      const realPackageName = parsed.name || requestedName;

      // Also check overrides for realPackageName
      if (this.overrides[realPackageName]) {
        rawRange = this.overrides[realPackageName];
      }

      // Security check: Block exotic transitive sources (git, tarball, local path) by default
      if (parentId && (parsed.type === 'file' || parsed.type === 'link' || parsed.type === 'git' || parsed.type === 'tarball')) {
        if (!mergedOptions.allowExoticTransitive) {
          throw new LinkPMError(
            `Security violation: Transitive exotic dependency "${requestedName}@${rawRange}" (type: ${parsed.type}) blocked by default`,
            {
              code: 'ERR_STORE_CORRUPTION',
              packageName: requestedName,
              requestedVersion: rawRange,
              hint: 'Transitive git, tarball, and local path dependencies pose supply-chain risks. Pass --allow-exotic-transitive or set allow-exotic-transitive=true in .npmrc to permit them.'
            }
          );
        }
      }

      // Handle git: dependencies with exact commit hash resolution
      if (parsed.type === 'git' && parsed.target) {
        let commitHash = parsed.range || 'HEAD';
        try {
          const gitCmd = `git ls-remote "${parsed.target}" ${parsed.range || 'HEAD'}`;
          const gitOut = execSync(gitCmd, { encoding: 'utf-8', timeout: 8000 });
          const firstLine = gitOut.trim().split(/\r?\n/)[0];
          if (firstLine) {
            const sha = firstLine.split(/\s+/)[0];
            if (/^[a-f0-9]{40}$/i.test(sha)) {
              commitHash = sha;
            }
          }
        } catch {}

        const nodeId = `${realPackageName}@git-${commitHash.slice(0, 10)}`;
        let node = graph.getNode(nodeId);
        if (!node) {
          node = {
            id: nodeId,
            name: realPackageName,
            version: `git-${commitHash.slice(0, 10)}`,
            tarballUrl: `${parsed.target}#${commitHash}`,
            isDev,
            isOptional,
            dependencies: new Map(),
            peerDependencies: {},
            parentIds: new Set()
          };
          graph.addNode(node);
        }

        if (parentId) {
          graph.addEdge(parentId, requestedName, nodeId);
        } else {
          if (isDev) {
            graph.rootDevDependencies.set(requestedName, nodeId);
          } else {
            graph.rootDependencies.set(requestedName, nodeId);
          }
        }
        continue;
      }

      // Handle local file: and link: protocols directly
      if (parsed.type === 'file' || parsed.type === 'link') {
        const localTarget = path.resolve(mergedOptions.projectRoot || process.cwd(), parsed.target || parsed.range);
        const pkgJsonFile = path.join(localTarget, 'package.json');
        let localVersion = '1.0.0';
        let localDeps: Record<string, string> = {};
        let localBin: any;

        if (fs.existsSync(pkgJsonFile)) {
          try {
            const parsedPkg = JSON.parse(fs.readFileSync(pkgJsonFile, 'utf-8'));
            localVersion = parsedPkg.version || '1.0.0';
            localDeps = parsedPkg.dependencies || {};
            localBin = parsedPkg.bin;
          } catch {}
        }

        const nodeId = `${realPackageName}@${localVersion}`;
        let node = graph.getNode(nodeId);
        if (!node) {
          node = {
            id: nodeId,
            name: realPackageName,
            version: localVersion,
            tarballUrl: `file://${localTarget}`,
            bin: localBin,
            isDev,
            isOptional,
            dependencies: new Map(),
            peerDependencies: {},
            parentIds: new Set()
          };
          graph.addNode(node);
        }

        if (parentId) {
          graph.addEdge(parentId, requestedName, nodeId);
        } else {
          if (isDev) {
            graph.rootDevDependencies.set(requestedName, nodeId);
          } else {
            graph.rootDependencies.set(requestedName, nodeId);
          }
        }

        for (const [dep, range] of Object.entries(localDeps)) {
          queue.push({
            requestedName: dep,
            rawRange: range,
            isDev: false,
            isOptional: false,
            parentId: nodeId
          });
        }
        continue;
      }

      const targetRange = parsed.range;

      const cacheKey = `${realPackageName}@${targetRange}`;
      if (visitedSpecs.has(cacheKey)) {
        const existingNodeId = visitedSpecs.get(cacheKey)!;
        if (parentId) {
          graph.addEdge(parentId, requestedName, existingNodeId);
        } else {
          if (isDev) {
            graph.rootDevDependencies.set(requestedName, existingNodeId);
          } else {
            graph.rootDependencies.set(requestedName, existingNodeId);
          }
        }
        continue;
      }

      // Check if optional package should be skipped due to OS/CPU mismatch
      if (isOptional && shouldSkipOptionalPackage(realPackageName)) {
        continue;
      }

      // Fetch manifest from registry client
      let manifest;
      try {
        manifest = await this.registryClient.getPackageManifest(realPackageName, mergedOptions);
      } catch (err: any) {
        if (isOptional) {
          // Gracefully skip failed optional dependency
          continue;
        }
        throw err;
      }

      // Resolve version matching targetRange with release-age cooldown
      const resolvedVersion = this.matchVersion(realPackageName, targetRange, manifest, mergedOptions);
      const versionMeta: PackageVersionMetadata = manifest.versions[resolvedVersion];
      if (!versionMeta) {
        if (isOptional) continue;
        throw new LinkPMError(`Version metadata for "${realPackageName}@${resolvedVersion}" not found`, {
          code: 'ERR_VERSION_NOT_FOUND',
          packageName: realPackageName,
          requestedVersion: targetRange,
          resolvedVersion
        });
      }

      // Check platform restrictions for non-optional packages
      if (isOptional && shouldSkipOptionalPackage(realPackageName, { os: versionMeta.os, cpu: versionMeta.cpu })) {
        continue;
      }

      const nodeId = `${realPackageName}@${resolvedVersion}`;
      visitedSpecs.set(cacheKey, nodeId);

      // Add to graph
      let node = graph.getNode(nodeId);
      if (!node) {
        node = {
          id: nodeId,
          name: realPackageName,
          version: resolvedVersion,
          tarballUrl: versionMeta.dist?.tarball || '',
          integrity: versionMeta.dist?.integrity,
          bin: versionMeta.bin,
          isDev,
          isOptional,
          dependencies: new Map(),
          peerDependencies: versionMeta.peerDependencies || {},
          peerDependenciesMeta: versionMeta.peerDependenciesMeta,
          parentIds: new Set()
        };
        graph.addNode(node);
      }

      if (parentId) {
        graph.addEdge(parentId, requestedName, nodeId);
      } else {
        if (isDev) {
          graph.rootDevDependencies.set(requestedName, nodeId);
        } else {
          graph.rootDependencies.set(requestedName, nodeId);
        }
      }

      // Enqueue transitive dependencies
      if (versionMeta.dependencies) {
        for (const [transDep, transRange] of Object.entries(versionMeta.dependencies)) {
          queue.push({
            requestedName: transDep,
            rawRange: transRange,
            isDev: false,
            isOptional: false,
            parentId: nodeId
          });
        }
      }

      // Enqueue optional dependencies
      if (versionMeta.optionalDependencies) {
        for (const [optDep, optRange] of Object.entries(versionMeta.optionalDependencies)) {
          queue.push({
            requestedName: optDep,
            rawRange: optRange,
            isDev: false,
            isOptional: true,
            parentId: nodeId
          });
        }
      }
    }

    // 4. Validate peer dependencies across the whole graph
    const peerResult = PeerEngine.validate(graph);
    if (!peerResult.valid && mergedOptions.strictPeers) {
      throw peerResult.conflicts[0];
    }

    return {
      graph,
      peerResult,
      totalResolved: graph.nodes.size
    };
  }

  private matchVersion(name: string, range: string, manifest: any, options: ResolveOptions = {}): string {
    const versions = Object.keys(manifest.versions || {});
    if (versions.length === 0) {
      throw new LinkPMError(`No published versions found for "${name}"`, {
        code: 'ERR_VERSION_NOT_FOUND',
        packageName: name
      });
    }

    const minAgeSec = options.minimumReleaseAge ?? 86400;
    const minAge = minAgeSec > 100000 ? minAgeSec : minAgeSec * 1000;
    const exclude = new Set(options.releaseAgeExclude || []);
    const enforceCooldown = !options.ignoreReleaseAge && !exclude.has(name) && minAge > 0 && manifest.time;

    // Filter versions that satisfy the minimum release age cooldown
    const cooldownSafeVersions = enforceCooldown
      ? versions.filter(v => {
          const published = manifest.time[v];
          if (!published) return true;
          return Date.now() - new Date(published).getTime() >= minAge;
        })
      : versions;

    // Check dist-tags e.g. "latest", "next", "beta"
    if (manifest['dist-tags'] && manifest['dist-tags'][range]) {
      const tagVer = manifest['dist-tags'][range];
      if (!enforceCooldown || cooldownSafeVersions.includes(tagVer)) {
        return tagVer;
      }
    }

    // Check exact version
    if (semver.valid(range) && versions.includes(range)) {
      if (enforceCooldown && !cooldownSafeVersions.includes(range)) {
        const pubTime = manifest.time[range];
        const ageHours = pubTime ? ((Date.now() - new Date(pubTime).getTime()) / (3600 * 1000)).toFixed(1) : 'unknown';
        throw new LinkPMError(
          `Security Cooldown: "${name}@${range}" was published ${ageHours}h ago (minimum release age: ${(minAge / (3600 * 1000)).toFixed(0)}h)`,
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

    // Semver range matching against cooldownSafeVersions first
    const matched = semver.maxSatisfying(cooldownSafeVersions, range, { includePrerelease: false }) ||
                    semver.maxSatisfying(cooldownSafeVersions, range, { includePrerelease: true });

    if (matched) {
      return matched;
    }

    // If semver matched in raw versions but was blocked by cooldown
    const unsafeMatch = semver.maxSatisfying(versions, range);
    if (unsafeMatch && enforceCooldown && !cooldownSafeVersions.includes(unsafeMatch)) {
      const pubTime = manifest.time[unsafeMatch];
      const ageHours = pubTime ? ((Date.now() - new Date(pubTime).getTime()) / (3600 * 1000)).toFixed(1) : 'unknown';
      throw new LinkPMError(
        `Security Cooldown: Latest satisfying version "${name}@${unsafeMatch}" was published ${ageHours}h ago (minimum release age: ${(minAge / (3600 * 1000)).toFixed(0)}h)`,
        {
          code: 'ERR_VERSION_NOT_FOUND',
          packageName: name,
          requestedVersion: range,
          hint: `To install this release immediately, pass --ignore-release-age or add "${name}" to release-age-exclude in .npmrc.`
        }
      );
    }

    // Fallback to latest tag if nothing satisfied
    if (manifest['dist-tags']?.latest) {
      const latestVer = manifest['dist-tags'].latest;
      if (!enforceCooldown || cooldownSafeVersions.includes(latestVer)) {
        return latestVer;
      }
    }

    throw new LinkPMError(`No version of "${name}" satisfies range "${range}"`, {
      code: 'ERR_VERSION_NOT_FOUND',
      packageName: name,
      requestedVersion: range,
      hint: `Available versions: ${versions.slice(-5).join(', ')}`
    });
  }
}
