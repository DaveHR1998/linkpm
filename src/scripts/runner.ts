import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import pc from 'picocolors';
import { buildScriptEnv } from './env.js';
import { LinkPMError } from '../utils/errors.js';

export interface RunScriptOptions {
  extraArgs?: string[];
  ifPresent?: boolean;
  ignoreScripts?: boolean;
  silent?: boolean;
}

export interface RunScriptResult {
  scriptName: string;
  exitCode: number;
  success: boolean;
}

export function readProjectScripts(projectRoot: string): { pkgJson: any; scripts: Record<string, string> } {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    throw new LinkPMError(`No package.json found at ${projectRoot}`, {
      code: 'ERR_PROJECT_NOT_FOUND',
      hint: 'Run "linkpm init" to create a new project.'
    });
  }

  try {
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const pkgJson = JSON.parse(raw);
    const scripts = (pkgJson.scripts && typeof pkgJson.scripts === 'object') ? pkgJson.scripts : {};
    return { pkgJson, scripts };
  } catch (err: any) {
    throw new LinkPMError(`Failed to parse package.json: ${err.message}`, {
      code: 'ERR_PROJECT_NOT_FOUND'
    });
  }
}

function executeSingleCommand(
  command: string,
  projectRoot: string,
  lifecycleEvent: string,
  pkgJson: any,
  silent: boolean = false
): number {
  if (!silent) {
    console.log(pc.bold(pc.cyan(`> ${lifecycleEvent}:`)) + ` ${command}`);
  }

  const env = buildScriptEnv(projectRoot, { lifecycleEvent, pkgJson });

  const result = spawnSync(command, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: true,
    env
  });

  return result.status ?? (result.signal ? 1 : 0);
}

export async function runScript(
  projectRoot: string,
  scriptName: string,
  options: RunScriptOptions = {}
): Promise<RunScriptResult> {
  const { pkgJson, scripts } = readProjectScripts(projectRoot);

  const hasTarget = Object.prototype.hasOwnProperty.call(scripts, scriptName);

  if (!hasTarget) {
    if (options.ifPresent) {
      return { scriptName, exitCode: 0, success: true };
    }

    const available = Object.keys(scripts);
    const hint = available.length > 0
      ? `Available scripts in package.json: ${available.join(', ')}`
      : 'No scripts defined in package.json.';

    throw new LinkPMError(`Missing script: "${scriptName}"`, {
      code: 'ERR_COMMAND_FAILED',
      hint
    });
  }

  if (options.ignoreScripts) {
    return { scriptName, exitCode: 0, success: true };
  }

  // 1. Run pre<script> if present
  const preScript = `pre${scriptName}`;
  if (scripts[preScript]) {
    const preExit = executeSingleCommand(scripts[preScript], projectRoot, preScript, pkgJson, options.silent);
    if (preExit !== 0) {
      return { scriptName: preScript, exitCode: preExit, success: false };
    }
  }

  // 2. Run target script with extra arguments appended
  let mainCommand = scripts[scriptName];
  if (options.extraArgs && options.extraArgs.length > 0) {
    mainCommand = `${mainCommand} ${options.extraArgs.join(' ')}`;
  }

  const mainExit = executeSingleCommand(mainCommand, projectRoot, scriptName, pkgJson, options.silent);
  if (mainExit !== 0) {
    return { scriptName, exitCode: mainExit, success: false };
  }

  // 3. Run post<script> if present
  const postScript = `post${scriptName}`;
  if (scripts[postScript]) {
    const postExit = executeSingleCommand(scripts[postScript], projectRoot, postScript, pkgJson, options.silent);
    if (postExit !== 0) {
      return { scriptName: postScript, exitCode: postExit, success: false };
    }
  }

  return { scriptName, exitCode: 0, success: true };
}
