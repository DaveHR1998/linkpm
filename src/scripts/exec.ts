import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildScriptEnv } from './env.js';
import { LinkPMError } from '../utils/errors.js';

export interface ExecOptions {
  extraEnv?: NodeJS.ProcessEnv;
}

export function execBin(
  projectRoot: string,
  binName: string,
  args: string[] = [],
  options: ExecOptions = {}
): number {
  const env = {
    ...buildScriptEnv(projectRoot),
    ...options.extraEnv
  };

  const binDir = path.join(projectRoot, 'node_modules', '.bin');
  let targetExecutable = binName;
  let useShell = false;

  if (process.platform === 'win32') {
    const cmdFile = path.join(binDir, `${binName}.cmd`);
    const plainFile = path.join(binDir, binName);
    const ps1File = path.join(binDir, `${binName}.ps1`);
    if (fs.existsSync(cmdFile)) {
      targetExecutable = cmdFile;
      useShell = true;
    } else if (fs.existsSync(plainFile)) {
      targetExecutable = plainFile;
    } else if (fs.existsSync(ps1File)) {
      targetExecutable = ps1File;
    }
  } else {
    const plainFile = path.join(binDir, binName);
    if (fs.existsSync(plainFile)) {
      targetExecutable = plainFile;
    }
  }

  const result = spawnSync(targetExecutable, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: useShell,
    env
  });

  return result.status ?? (result.signal ? 1 : 0);
}
