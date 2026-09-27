import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface NpmrcConfig {
  registry: string;
  scopedRegistries: Record<string, string>;
  authTokens: Record<string, string>;
  strictSsl: boolean;
  cafile?: string;
  proxy?: string;
  httpsProxy?: string;
  storeDir?: string;
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

  // 1. User ~/.npmrc
  const userNpmrc = path.join(os.homedir(), '.npmrc');
  if (fs.existsSync(userNpmrc)) {
    try {
      const parsed = parseNpmrcContent(fs.readFileSync(userNpmrc, 'utf-8'));
      Object.assign(config, parsed);
    } catch {}
  }

  // 2. Project .npmrc (overrides user)
  if (projectRoot) {
    const projectNpmrc = path.join(projectRoot, '.npmrc');
    if (fs.existsSync(projectNpmrc)) {
      try {
        const parsed = parseNpmrcContent(fs.readFileSync(projectNpmrc, 'utf-8'));
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

  return {
    registry,
    scopedRegistries,
    authTokens,
    strictSsl,
    cafile,
    proxy,
    httpsProxy,
    storeDir,
    raw: config
  };
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
