import fs from 'node:fs';
import path from 'node:path';

export interface IdeInitResult {
  vscodeCreated: boolean;
  vscodeUpdated: boolean;
  vscodePath: string;
  tsconfigUpdated: boolean;
  tsconfigPath?: string;
  message: string;
}

/**
 * Safely parses a JSON file that may contain single-line or multi-line comments.
 */
function parseJsonWithComments(content: string): any {
  // Strip single-line and multi-line comments
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1');
  return JSON.parse(stripped);
}

/**
 * Automatically configures IDE and TypeScript Language Server settings (.vscode/settings.json and tsconfig.json).
 * Ensures "typescript.tsdk" points to workspace TypeScript and "preserveSymlinks: true" is set
 * so VS Code, Cursor, and WebStorm's TS Server accurately follow store symlinks and directory junctions.
 */
export function initIdeConfig(
  projectRoot: string,
  options: { enablePlugin?: boolean; enableDiagnostics?: boolean } = {}
): IdeInitResult {
  let vscodeCreated = false;
  let vscodeUpdated = false;
  let tsconfigUpdated = false;

  // 1. Configure .vscode/settings.json
  const vscodeDir = path.join(projectRoot, '.vscode');
  const settingsPath = path.join(vscodeDir, 'settings.json');

  if (!fs.existsSync(vscodeDir)) {
    fs.mkdirSync(vscodeDir, { recursive: true });
  }

  let settings: Record<string, any> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = parseJsonWithComments(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      settings = {};
    }
  } else {
    vscodeCreated = true;
  }

  const originalSettingsJson = JSON.stringify(settings);

  // Pin typescript.tsdk only when the workspace TypeScript actually ships the
  // classic language server. TypeScript 7 (tsgo) has no lib/tsserver.js — a
  // tsdk pin pointing there leaves the editor with NO language server and
  // misleading red import/type errors. In presets the scaffolded template
  // already installs typescript, so we must check first.
  const workspaceTsDK = path.join(projectRoot, 'node_modules', 'typescript', 'lib');
  const hasTsserver = fs.existsSync(path.join(workspaceTsDK, 'tsserver.js'));
  const hasTsgo = !hasTsserver && fs.existsSync(path.join(workspaceTsDK, 'tsc.js'));

  const desiredSettings: Record<string, any> = {
    'typescript.preferences.includePackageJsonAutoImports': 'auto',
    'typescript.npm': 'linkpm'
  };

  if (!hasTsgo) {
    desiredSettings['typescript.tsdk'] = 'node_modules/typescript/lib';
  }

  for (const [key, value] of Object.entries(desiredSettings)) {
    if (settings[key] !== value) {
      settings[key] = value;
    }
  }

  // Repair previously written, now-harmful pins if tsgo is detected
  if (hasTsgo && 'typescript.tsdk' in settings) {
    delete settings['typescript.tsdk'];
  }

  // Compare final state against original to decide whether to write
  const settingsChanged = JSON.stringify(settings) !== originalSettingsJson;

  if (settingsChanged || vscodeCreated) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    vscodeUpdated = true;
  }

  // 2. Configure tsconfig.json / jsconfig.json
  const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
  let targetTsconfig: string | undefined;

  if (fs.existsSync(tsconfigPath)) {
    targetTsconfig = tsconfigPath;
  } else {
    const jsconfigPath = path.join(projectRoot, 'jsconfig.json');
    if (fs.existsSync(jsconfigPath)) {
      targetTsconfig = jsconfigPath;
    }
  }

  if (targetTsconfig) {
    try {
      const raw = fs.readFileSync(targetTsconfig, 'utf-8');
      const tsconfig = parseJsonWithComments(raw);
      if (!tsconfig.compilerOptions) {
        tsconfig.compilerOptions = {};
      }

      let tsChanged = false;
      // Enable preserveSymlinks so TS Server follows store junctions
      if (tsconfig.compilerOptions.preserveSymlinks !== true) {
        tsconfig.compilerOptions.preserveSymlinks = true;
        tsChanged = true;
      }

      // If plugin requested, configure linkpm-ts-plugin
      if (options.enablePlugin) {
        const plugins = Array.isArray(tsconfig.compilerOptions.plugins)
          ? [...tsconfig.compilerOptions.plugins]
          : [];
        if (!plugins.some((p: any) => p.name === 'linkpm-ts-plugin')) {
          plugins.push({ name: 'linkpm-ts-plugin' });
          tsconfig.compilerOptions.plugins = plugins;
          tsChanged = true;
        }
      }

      if (tsChanged) {
        fs.writeFileSync(targetTsconfig, JSON.stringify(tsconfig, null, 2) + '\n', 'utf-8');
        tsconfigUpdated = true;
      }
    } catch {}
  }

  return {
    vscodeCreated,
    vscodeUpdated,
    vscodePath: settingsPath,
    tsconfigUpdated,
    tsconfigPath: targetTsconfig,
    message: vscodeCreated
      ? 'Generated .vscode/settings.json and optimized TypeScript Language Server settings.'
      : 'Updated .vscode/settings.json with workspace TypeScript and symlink resolution.'
  };
}

export interface IdeDiagnostics {
  hasVscodeSettings: boolean;
  hasTsdkConfigured: boolean;
  hasPreserveSymlinks: boolean;
  isReady: boolean;
  recommendations: string[];
}

/**
 * Inspects the current project for IDE & TypeScript LSP configuration readiness.
 */
export function checkIdeDiagnostics(projectRoot: string): IdeDiagnostics {
  const settingsPath = path.join(projectRoot, '.vscode', 'settings.json');
  const tsconfigPath = path.join(projectRoot, 'tsconfig.json');

  let hasVscodeSettings = false;
  let hasTsdkConfigured = false;
  let hasPreserveSymlinks = false;
  const recommendations: string[] = [];

  if (fs.existsSync(settingsPath)) {
    hasVscodeSettings = true;
    try {
      const settings = parseJsonWithComments(fs.readFileSync(settingsPath, 'utf-8'));
      if (settings['typescript.tsdk']) {
        hasTsdkConfigured = true;
      }
    } catch {}
  }

  if (!hasTsdkConfigured) {
    recommendations.push('Set "typescript.tsdk": "node_modules/typescript/lib" in .vscode/settings.json');
  }

  if (fs.existsSync(tsconfigPath)) {
    try {
      const tsconfig = parseJsonWithComments(fs.readFileSync(tsconfigPath, 'utf-8'));
      if (tsconfig.compilerOptions && tsconfig.compilerOptions.preserveSymlinks === true) {
        hasPreserveSymlinks = true;
      }
    } catch {}
    if (!hasPreserveSymlinks) {
      recommendations.push('Set "preserveSymlinks": true in tsconfig.json compilerOptions');
    }
  } else {
    // If no tsconfig, not applicable
    hasPreserveSymlinks = true;
  }

  const isReady = hasTsdkConfigured && hasPreserveSymlinks;

  return {
    hasVscodeSettings,
    hasTsdkConfigured,
    hasPreserveSymlinks,
    isReady,
    recommendations
  };
}
