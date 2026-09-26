import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import pc from 'picocolors';
import { LINKPM_HOME, safePackageName } from '../config/index.js';
import { resolvePackage, downloadTarball } from '../registry.js';
import { FetchManager } from '../fetch/index.js';
import { LinkPMError } from '../utils/errors.js';
import { buildScriptEnv } from './env.js';

export const DLX_CACHE_DIR = path.join(LINKPM_HOME, 'dlx-cache');

export interface DlxOptions {
  packageSpec: string;
  args: string[];
}

export async function runDlx(packageSpec: string, binArgs: string[] = []): Promise<number> {
  const resolved = await resolvePackage(packageSpec);
  const safeName = safePackageName(resolved.name);
  const targetDir = path.join(DLX_CACHE_DIR, safeName, resolved.version);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    const tarballPath = await downloadTarball(resolved);
    const tempDir = `${targetDir}.extracting-${Date.now()}`;
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      await FetchManager.safeExtractTar(tarballPath, tempDir);
      fs.renameSync(tempDir, targetDir);
    } catch (err: any) {
      if (fs.existsSync(tempDir)) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
      throw err;
    }
  }

  const pkgJsonPath = path.join(targetDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    throw new LinkPMError(`Corrupted dlx package: missing package.json for ${resolved.name}`, {
      code: 'ERR_STORE_CORRUPTION'
    });
  }

  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
  let binRelative: string | null = null;

  if (typeof pkgJson.bin === 'string') {
    binRelative = pkgJson.bin;
  } else if (pkgJson.bin && typeof pkgJson.bin === 'object') {
    // Look for matching name or pick first
    const simpleName = resolved.name.startsWith('@') ? resolved.name.split('/')[1] : resolved.name;
    binRelative = pkgJson.bin[simpleName] || Object.values(pkgJson.bin)[0] as string;
  }

  if (!binRelative) {
    throw new LinkPMError(`Package "${resolved.name}" does not define any executable binary in its package.json`, {
      code: 'ERR_COMMAND_FAILED'
    });
  }

  const binAbsolutePath = path.resolve(targetDir, binRelative);
  if (!fs.existsSync(binAbsolutePath)) {
    throw new LinkPMError(`Binary executable not found at ${binAbsolutePath}`, {
      code: 'ERR_COMMAND_FAILED'
    });
  }

  // Prepend targetDir/node_modules/.bin to PATH
  const env = buildScriptEnv(targetDir);

  const command = `node "${binAbsolutePath}" ${binArgs.join(' ')}`;
  const res = spawnSync(command, {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: true,
    env
  });

  return res.status ?? (res.signal ? 1 : 0);
}
