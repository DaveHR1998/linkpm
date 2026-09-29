import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getStoreDir } from '../config/index.js';

export interface MetroInitResult {
  created: boolean;
  updated: boolean;
  filePath: string;
  storePath: string;
  message: string;
}

/**
 * Programmatic helper to wrap an existing Metro config object
 * with LinkPM central store watchFolders and symlink resolution.
 */
export function withLinkPM(
  metroConfig: any = {},
  options: { storeDir?: string; projectRoot?: string } = {}
): any {
  const storePath = options.storeDir || getStoreDir();
  const root = options.projectRoot || process.cwd();

  const existingWatchFolders = Array.isArray(metroConfig.watchFolders)
    ? [...metroConfig.watchFolders]
    : [];

  if (!existingWatchFolders.includes(storePath)) {
    existingWatchFolders.push(storePath);
  }

  const existingResolver = metroConfig.resolver || {};
  const existingNodeModulesPaths = Array.isArray(existingResolver.nodeModulesPaths)
    ? [...existingResolver.nodeModulesPaths]
    : [];

  const projectNodeModules = path.resolve(root, 'node_modules');
  if (!existingNodeModulesPaths.includes(projectNodeModules)) {
    existingNodeModulesPaths.push(projectNodeModules);
  }

  return {
    ...metroConfig,
    watchFolders: existingWatchFolders,
    resolver: {
      ...existingResolver,
      unstable_enableSymlinks: true,
      nodeModulesPaths: existingNodeModulesPaths
    }
  };
}

const METRO_CONFIG_FILES = [
  'metro.config.js',
  'metro.config.cjs',
  'metro.config.mjs',
  'metro.config.ts'
];

/**
 * Injects LinkPM store watchFolders and unstable_enableSymlinks into the project's metro.config.js.
 * If no metro.config.js exists, generates a ready-to-run Metro configuration.
 */
export function initMetroConfig(projectRoot: string): MetroInitResult {
  const storePath = getStoreDir();

  // 1. Detect existing Metro configuration file
  let targetFile: string | null = null;
  for (const name of METRO_CONFIG_FILES) {
    const fullPath = path.join(projectRoot, name);
    if (fs.existsSync(fullPath)) {
      targetFile = fullPath;
      break;
    }
  }

  // 2. If no config exists, create a new metro.config.js
  if (!targetFile) {
    const newConfigPath = path.join(projectRoot, 'metro.config.js');
    const newContent = `const path = require('node:path');
const os = require('node:os');

// LinkPM Zero-Copy Store configuration for React Native Metro Bundler
// Enables instant symlink/junction resolution and watches central store
const linkpmStorePath = process.env.LINKPM_STORE_DIR || path.join(os.homedir(), '.linkpm', 'store');

let config;
try {
  const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
  const defaultConfig = getDefaultConfig(__dirname);
  const linkpmConfig = {
    watchFolders: [linkpmStorePath],
    resolver: {
      unstable_enableSymlinks: true,
      nodeModulesPaths: [path.resolve(__dirname, 'node_modules')]
    }
  };
  config = mergeConfig(defaultConfig, linkpmConfig);
} catch {
  // Fallback for vanilla Metro or custom setups
  config = {
    watchFolders: [linkpmStorePath],
    resolver: {
      unstable_enableSymlinks: true,
      nodeModulesPaths: [path.resolve(__dirname, 'node_modules')]
    }
  };
}

module.exports = config;
`;

    fs.writeFileSync(newConfigPath, newContent, 'utf-8');
    return {
      created: true,
      updated: false,
      filePath: newConfigPath,
      storePath,
      message: `Created ${path.basename(newConfigPath)} with zero-copy store watchFolders and unstable_enableSymlinks.`
    };
  }

  // 3. Existing config found: check if already configured
  const existingContent = fs.readFileSync(targetFile, 'utf-8');
  if (
    existingContent.includes('[linkpm-metro-helper]') ||
    existingContent.includes('unstable_enableSymlinks') ||
    existingContent.includes('.linkpm')
  ) {
    return {
      created: false,
      updated: false,
      filePath: targetFile,
      storePath,
      message: `${path.basename(targetFile)} is already configured for LinkPM.`
    };
  }

  // 4. Inject non-destructive helper wrapper
  const helperSnippet = `

// [linkpm-metro-helper] Auto-configured by "linkpm metro-init"
(function() {
  const _path = require('node:path');
  const _os = require('node:os');
  const _linkpmStore = process.env.LINKPM_STORE_DIR || _path.join(_os.homedir(), '.linkpm', 'store');
  const _patch = (cfg) => {
    if (!cfg) return cfg;
    const folders = Array.isArray(cfg.watchFolders) ? [...cfg.watchFolders] : [];
    if (!folders.includes(_linkpmStore)) folders.push(_linkpmStore);
    cfg.watchFolders = folders;
    cfg.resolver = {
      ...(cfg.resolver || {}),
      unstable_enableSymlinks: true,
      nodeModulesPaths: [
        ...((cfg.resolver && cfg.resolver.nodeModulesPaths) || []),
        _path.resolve(__dirname, 'node_modules')
      ]
    };
    return cfg;
  };
  if (module.exports) {
    const _orig = module.exports;
    module.exports = typeof _orig === 'function'
      ? async (...args) => _patch(await _orig(...args))
      : _patch(_orig);
  }
})();
`;

  fs.writeFileSync(targetFile, existingContent + helperSnippet, 'utf-8');

  return {
    created: false,
    updated: true,
    filePath: targetFile,
    storePath,
    message: `Injected LinkPM store watchFolders and unstable_enableSymlinks into ${path.basename(targetFile)}.`
  };
}
