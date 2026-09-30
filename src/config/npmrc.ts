import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type LinkerMode = 'junction' | 'hoisted';

export interface NpmrcConfig {
  registry: string;
  scopedRegistries: Record<string, string>;
  authTokens: Record<string, string>;
  strictSsl: boolean;
  cafile?: string;
  proxy?: string;
  httpsProxy?: string;
  storeDir?: string;
  linker?: LinkerMode;
  minimumReleaseAge: number; // in milliseconds, default 24h
  releaseAgeExclude: string[];
  allowExoticTransitive: boolean;
  raw: Record<string, string>;
}

export function parseNpmrcContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    result[key] = val;
  }

  return result;
}

export function loadNpmrc(projectRoot?: string): NpmrcConfig {
  const config: Record<string, string> = {};

  // 1. User ~/.npmrc and ~/.linkpmrc
  const userNpmrc = path.join(os.homedir(), '.npmrc');
  if (fs.existsSync(userNpmrc)) {
    try {
      const parsed = parseNpmrcContent(fs.readFileSync(userNpmrc, 'utf-8'));
      Object.assign(config, parsed);
    } catch {}
  }
  const userLinkpmrc = path.join(os.homedir(), '.linkpmrc');
  if (fs.existsSync(userLinkpmrc)) {
    try {
      const parsed = parseNpmrcContent(fs.readFileSync(userLinkpmrc, 'utf-8'));
      Object.assign(config, parsed);
    } catch {}
  }

  // 2. Project .npmrc and .linkpmrc (overrides user)
  if (projectRoot) {
    const projectNpmrc = path.join(projectRoot, '.npmrc');
    if (fs.existsSync(projectNpmrc)) {
      try {
        const parsed = parseNpmrcContent(fs.readFileSync(projectNpmrc, 'utf-8'));
        Object.assign(config, parsed);
      } catch {}
    }
    const projectLinkpmrc = path.join(projectRoot, '.linkpmrc');
    if (fs.existsSync(projectLinkpmrc)) {
      try {
        const parsed = parseNpmrcContent(fs.readFileSync(projectLinkpmrc, 'utf-8'));
        Object.assign(config, parsed);
      } catch {}
    }
  }

  // 3. Environment variables npm_config_*
  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (envKey.toLowerCase().startsWith('npm_config_') && envVal !== undefined) {
      const key = envKey.slice('npm_config_'.length).toLowerCase().replace(/_/g, '-');
      config[key] = envVal;
    }
  }

  const defaultRegistry = 'https://registry.npmjs.org/';
  let registry = config['registry'] || defaultRegistry;
  if (!registry.endsWith('/')) registry += '/';

  const scopedRegistries: Record<string, string> = {};
  const authTokens: Record<string, string> = {};

  for (const [k, v] of Object.entries(config)) {
    // Scoped registry: @scope:registry = https://...
    if (k.startsWith('@') && k.endsWith(':registry')) {
      const scope = k.slice(0, k.indexOf(':'));
      let regUrl = v.trim();
      if (!regUrl.endsWith('/')) regUrl += '/';
      scopedRegistries[scope] = regUrl;
    }

    // Auth token: //registry.npmjs.org/:_authToken = ...
    if (k.includes(':_authToken')) {
      const hostPart = k.slice(0, k.indexOf(':_authToken')).replace(/^\/\//, '');
      authTokens[hostPart] = v.trim();
    }
  }

  const strictSsl = config['strict-ssl'] !== 'false';
  const cafile = config['cafile'];
  const proxy = config['proxy'] || process.env.HTTP_PROXY || process.env.http_proxy;
  const httpsProxy = config['https-proxy'] || process.env.HTTPS_PROXY || process.env.https_proxy;
  const storeDir = config['store-dir'] || config['store_dir'];

  // Parse minimum-release-age (default: 24h = 86400s)
  let minimumReleaseAge = 86400;
  const rawMinAge = config['minimum-release-age'] || config['minimum_release_age'];
  if (rawMinAge !== undefined) {
    if (rawMinAge.endsWith('h')) {
      minimumReleaseAge = parseFloat(rawMinAge) * 3600;
    } else if (rawMinAge.endsWith('d')) {
      minimumReleaseAge = parseFloat(rawMinAge) * 86400;
    } else if (rawMinAge.endsWith('m')) {
      minimumReleaseAge = parseFloat(rawMinAge) * 60;
    } else if (rawMinAge.endsWith('s')) {
      minimumReleaseAge = parseFloat(rawMinAge);
    } else if (!isNaN(Number(rawMinAge))) {
      minimumReleaseAge = Number(rawMinAge);
    }
  }

  // Parse release-age-exclude
  const rawExclude = config['release-age-exclude'] || config['release_age_exclude'] || '';
  const releaseAgeExclude = rawExclude.split(',').map(s => s.trim()).filter(Boolean);

  // Parse allow-exotic-transitive
  const allowExoticTransitive = config['allow-exotic-transitive'] === 'true' || config['allow_exotic_transitive'] === 'true';

  // Parse linker mode: 'junction' or 'hoisted'
  const rawLinker = config['linker'] || config['linkpm-linker'] || config['linkpm_linker'] || process.env.LINKPM_LINKER;
  const linker: LinkerMode | undefined = rawLinker === 'hoisted' ? 'hoisted' : (rawLinker === 'junction' ? 'junction' : undefined);

  return {
    registry,
    scopedRegistries,
    authTokens,
    strictSsl,
    cafile,
    proxy,
    httpsProxy,
    storeDir,
    linker,
    minimumReleaseAge,
    releaseAgeExclude,
    allowExoticTransitive,
    raw: config
  };
}

export const loadNpmrcConfig = loadNpmrc;

/**
 * Known frameworks and tools whose module resolution or bundling engines
 * fail with directory junctions/symlinks and require flat hoisted node_modules.
 */
export const HOISTED_FRAMEWORK_TRIGGERS = [
  'express',
  'react-native',
  '@react-native',
  'expo',
  '@expo',
  '@nestjs',
  'next',
  'nuxt',
  'webpack',
  'fastify',
  'koa',
  '@types/express',
  'metro'
];

/**
 * Checks if the project contains dependencies indicating Node/Express/React Native/Metro
 * or other frameworks that require flat hoisted node_modules layout.
 */
export function isHoistedFrameworkProject(projectRoot?: string): boolean {
  if (!projectRoot) return false;
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
      ...(pkg.peerDependencies || {})
    };
    return HOISTED_FRAMEWORK_TRIGGERS.some(trigger => {
      return Object.keys(allDeps).some(dep => dep === trigger || dep.startsWith(trigger + '/') || dep.startsWith('@' + trigger));
    });
  } catch {
    return false;
  }
}

/**
 * Resolves the active linker mode with precedence:
 * 1. Explicit CLI flag (--linker)
 * 2. Process environment variable (LINKPM_LINKER)
 * 3. package.json ("linkpm": { "linker": "..." } or "linker": "...")
 * 4. .linkpmrc / .npmrc config file
 * 5. Default: 'junction' (zero-copy central store with NTFS junctions / symlinks)
 */
export function getLinkerMode(projectRoot?: string, cliOption?: string): LinkerMode {
  if (cliOption === 'hoisted' || cliOption === 'junction') {
    return cliOption;
  }
  if (process.env.LINKPM_LINKER === 'hoisted' || process.env.LINKPM_LINKER === 'junction') {
    return process.env.LINKPM_LINKER;
  }
  if (projectRoot) {
    try {
      const pkgPath = path.join(projectRoot, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const pkgLinker = pkg.linkpm?.linker || pkg.linker;
        if (pkgLinker === 'hoisted' || pkgLinker === 'junction') {
          return pkgLinker;
        }
      }
    } catch {}

    const npmrc = loadNpmrc(projectRoot);
    if (npmrc.linker) {
      return npmrc.linker;
    }
  } else {
    const npmrc = loadNpmrc();
    if (npmrc.linker) {
      return npmrc.linker;
    }
  }

  // Default to 'junction' for zero-copy central store linking and instant disk space savings
  return 'junction';
}


export function getRegistryForPackage(packageName: string, npmrc: NpmrcConfig): string {
  if (packageName.startsWith('@')) {
    const [scope] = packageName.split('/');
    if (npmrc.scopedRegistries[scope]) {
      return npmrc.scopedRegistries[scope];
    }
  }
  return npmrc.registry;
}

export function getAuthHeaderForRegistry(registryUrl: string, npmrc: NpmrcConfig): string | null {
  try {
    const urlObj = new URL(registryUrl);
    const host = urlObj.host;

    // Check direct host match e.g. registry.npmjs.org
    if (npmrc.authTokens[host]) {
      return `Bearer ${npmrc.authTokens[host]}`;
    }

    // Check host with pathname e.g. registry.npmjs.org/
    const hostWithPath = `${host}${urlObj.pathname}`.replace(/\/$/, '');
    if (npmrc.authTokens[hostWithPath]) {
      return `Bearer ${npmrc.authTokens[hostWithPath]}`;
    }
  } catch {}

  // Fallback to process.env.NPM_TOKEN
  if (process.env.NPM_TOKEN) {
    return `Bearer ${process.env.NPM_TOKEN}`;
  }

  return null;
}
