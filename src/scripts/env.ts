import fs from 'node:fs';
import path from 'node:path';

export interface ScriptEnvOptions {
  lifecycleEvent?: string;
  pkgJson?: { name?: string; version?: string };
}

export function buildScriptEnv(projectRoot: string, options: ScriptEnvOptions = {}): NodeJS.ProcessEnv {
  const binDirs: string[] = [];
  let currentDir = path.resolve(projectRoot);

  // Traverse upwards to collect all nested and parent node_modules/.bin directories
  while (true) {
    const binPath = path.join(currentDir, 'node_modules', '.bin');
    if (fs.existsSync(binPath)) {
      binDirs.push(binPath);
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  const existingPath = process.env.PATH || process.env.Path || '';
  const newPath = [...binDirs, existingPath].filter(Boolean).join(path.delimiter);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: newPath,
    Path: newPath,
    INIT_CWD: process.cwd(),
    npm_config_user_agent: 'linkpm/1.0.1 node/' + process.version + ' ' + process.platform + ' ' + process.arch,
    npm_execpath: process.argv[1] || 'linkpm'
  };

  if (options.lifecycleEvent) {
    env.npm_lifecycle_event = options.lifecycleEvent;
  }

  if (options.pkgJson?.name) {
    env.npm_package_name = options.pkgJson.name;
  }

  if (options.pkgJson?.version) {
    env.npm_package_version = options.pkgJson.version;
  }

  return env;
}
