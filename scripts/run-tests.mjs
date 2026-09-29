import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const testsDir = path.join(rootDir, 'tests');

// Explicitly discover all test files to avoid shell glob expansion issues on Windows (cmd.exe) and older Node.js runtimes
const testFiles = fs.readdirSync(testsDir)
  .filter(file => file.endsWith('.test.ts'))
  .sort()
  .map(file => path.join('tests', file));

const isWin = process.platform === 'win32';
const command = isWin ? 'tsx.cmd' : 'tsx';

const result = spawnSync(command, ['--test', ...testFiles], {
  cwd: rootDir,
  stdio: 'inherit',
  shell: true
});

process.exit(result.status ?? (result.error ? 1 : 0));
