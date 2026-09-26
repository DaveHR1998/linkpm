import { LinkPMError } from './utils/errors.js';
import fs from 'node:fs';
import path from 'node:path';

export interface LinkResult {
  packageName: string;
  sourceDir: string;
  targetDir: string;
  binsLinked: string[];
}

export function ensureNodeModules(projectRoot: string): string {
  const nmPath = path.join(projectRoot, 'node_modules');
  if (!fs.existsSync(nmPath)) {
    fs.mkdirSync(nmPath, { recursive: true });
  }
  return nmPath;
}

export function linkPackage(
  projectRoot: string,
  packageName: string,
  storePackageDir: string
): LinkResult {
  if (!fs.existsSync(storePackageDir)) {
    throw new LinkPMError(`Cannot link package "${packageName}": store directory "${storePackageDir}" does not exist`, {
      code: 'ERR_STORE_CORRUPTION',
      packageName
    });
  }
  const nodeModulesDir = ensureNodeModules(projectRoot);

  let targetDir: string;
  if (packageName.startsWith('@')) {
    const [scope, pkgName] = packageName.split('/');
    const scopeDir = path.join(nodeModulesDir, scope);
    if (!fs.existsSync(scopeDir)) {
      fs.mkdirSync(scopeDir, { recursive: true });
    }
    targetDir = path.join(scopeDir, pkgName);
  } else {
    targetDir = path.join(nodeModulesDir, packageName);
  }

  // Remove existing target if it exists
  if (fs.existsSync(targetDir) || isSymbolicOrJunction(targetDir)) {
    try {
      const stats = fs.lstatSync(targetDir);
      if (stats.isSymbolicLink()) {
        fs.unlinkSync(targetDir);
      } else if (stats.isDirectory()) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
    } catch {
      // Fallback removal
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  }

  // Create junction on Windows, symlink on Unix
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(storePackageDir, targetDir, linkType);

  // Link executable binaries
  const binsLinked = linkBinaries(projectRoot, packageName, storePackageDir);

  return {
    packageName,
    sourceDir: storePackageDir,
    targetDir,
    binsLinked
  };
}

function isSymbolicOrJunction(targetPath: string): boolean {
  try {
    const stat = fs.lstatSync(targetPath);
    return stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export function linkBinaries(
  projectRoot: string,
  packageName: string,
  storePackageDir: string
): string[] {
  const pkgJsonPath = path.join(storePackageDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return [];

  let pkgJson: any;
  try {
    pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
  } catch {
    return [];
  }

  if (!pkgJson.bin) return [];

  const binMap: Record<string, string> = {};
  if (typeof pkgJson.bin === 'string') {
    const binName = packageName.startsWith('@') ? packageName.split('/')[1] : packageName;
    binMap[binName] = pkgJson.bin;
  } else if (typeof pkgJson.bin === 'object' && pkgJson.bin !== null) {
    Object.assign(binMap, pkgJson.bin);
  }

  const binDir = path.join(projectRoot, 'node_modules', '.bin');
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }

  const linkedNames: string[] = [];

  for (const [binName, relTarget] of Object.entries(binMap)) {
    const targetScriptPath = path.resolve(storePackageDir, relTarget);
    if (!fs.existsSync(targetScriptPath)) continue;

    // Relative path through project node_modules rather than global store
    const nmRelScript = path.join('..', packageName, relTarget).replace(/\\/g, '/');

    // 1. Unix shell script
    const shScriptPath = path.join(binDir, binName);
    const shContent = `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")
export NODE_PATH="$basedir/..:$NODE_PATH"
exec node --preserve-symlinks --preserve-symlinks-main "$basedir/${nmRelScript}" "$@"
`;
    fs.writeFileSync(shScriptPath, shContent, { mode: 0o755 });

    // 2. Windows CMD script
    const cmdScriptPath = path.join(binDir, `${binName}.cmd`);
    const cmdContent = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
SET NODE_PATH=%dp0%\\..;%NODE_PATH%
node --preserve-symlinks --preserve-symlinks-main "%dp0%\\${nmRelScript.replace(/\//g, '\\')}" %*
`;
    fs.writeFileSync(cmdScriptPath, cmdContent, 'utf-8');

    // 3. Windows PowerShell script
    const ps1ScriptPath = path.join(binDir, `${binName}.ps1`);
    const ps1Content = `#!/usr/bin/env pwsh
$basedir = Split-Path $MyInvocation.MyCommand.Path -Parent
$env:NODE_PATH = "$basedir/..;$env:NODE_PATH"
& node --preserve-symlinks --preserve-symlinks-main "$basedir/${nmRelScript.replace(/\//g, '\\')}" $args
exit $LASTEXITCODE
`;
    fs.writeFileSync(ps1ScriptPath, ps1Content, 'utf-8');

    linkedNames.push(binName);
  }

  return linkedNames;
}

export function unlinkPackage(projectRoot: string, packageName: string): boolean {
  const nodeModulesDir = path.join(projectRoot, 'node_modules');
  let targetDir: string;

  if (packageName.startsWith('@')) {
    const [scope, pkgName] = packageName.split('/');
    targetDir = path.join(nodeModulesDir, scope, pkgName);
  } else {
    targetDir = path.join(nodeModulesDir, packageName);
  }

  let removed = false;

  // Clean bin shims if present
  const pkgJsonPath = path.join(targetDir, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      if (pkgJson.bin) {
        const binNames = typeof pkgJson.bin === 'string'
          ? [packageName.startsWith('@') ? packageName.split('/')[1] : packageName]
          : Object.keys(pkgJson.bin);

        const binDir = path.join(nodeModulesDir, '.bin');
        for (const b of binNames) {
          fs.rmSync(path.join(binDir, b), { force: true });
          fs.rmSync(path.join(binDir, `${b}.cmd`), { force: true });
          fs.rmSync(path.join(binDir, `${b}.ps1`), { force: true });
        }
      }
    } catch {}
  }

  if (fs.existsSync(targetDir) || isSymbolicOrJunction(targetDir)) {
    try {
      const stats = fs.lstatSync(targetDir);
      if (stats.isSymbolicLink()) {
        fs.unlinkSync(targetDir);
      } else {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
      removed = true;
    } catch {
      fs.rmSync(targetDir, { recursive: true, force: true });
      removed = true;
    }
  }

  // If scoped, clean scope dir if empty
  if (packageName.startsWith('@')) {
    const scopeDir = path.join(nodeModulesDir, packageName.split('/')[0]);
    try {
      if (fs.existsSync(scopeDir) && fs.readdirSync(scopeDir).length === 0) {
        fs.rmdirSync(scopeDir);
      }
    } catch {}
  }

  return removed;
}
