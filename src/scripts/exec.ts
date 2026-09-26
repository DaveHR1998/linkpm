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

  const fullCommand = args.length > 0 ? `${binName} ${args.join(' ')}` : binName;

  const result = spawnSync(fullCommand, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: true,
    env
  });

  return result.status ?? (result.signal ? 1 : 0);
}
