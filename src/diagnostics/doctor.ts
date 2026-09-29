import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import pc from 'picocolors';
import { LINKPM_HOME, getStoreDir, TARBALLS_DIR, loadNpmrc } from '../config/index.js';
import { LOCKFILE_NAME, readLockfile } from '../lockfile/index.js';
import { readPackageJson } from '../package-json.js';
import { checkIdeDiagnostics, initIdeConfig } from '../ide/index.js';

export interface DiagnosticCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  details?: string;
}

export async function runDoctor(
  projectRoot: string = process.cwd(),
  options: { fix?: boolean } = {}
): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];

  // 1. Node.js Version
  const currentVer = process.version;
  const isNodeSupported = semver.gte(currentVer, '18.0.0');
  checks.push({
    name: 'Node.js Runtime',
    status: isNodeSupported ? 'pass' : 'fail',
    message: isNodeSupported ? `${currentVer} (Supported >=18.0.0)` : `${currentVer} (LinkPM requires Node >=18.0.0)`
  });

  // 2. Platform & Arch
  checks.push({
    name: 'Platform & Arch',
    status: 'pass',
    message: `${process.platform} (${process.arch})`
  });

  // 3. LinkPM Global Directories
  const dirs = [
    { label: 'LinkPM Home', path: LINKPM_HOME },
    { label: 'Central Store', path: getStoreDir() },
    { label: 'Tarball Cache', path: TARBALLS_DIR }
  ];

  for (const d of dirs) {
    let status: 'pass' | 'fail' = 'pass';
    let msg = `Exists: ${d.path}`;
    try {
      if (!fs.existsSync(d.path)) {
        fs.mkdirSync(d.path, { recursive: true });
        msg = `Created: ${d.path}`;
      }
      fs.accessSync(d.path, fs.constants.R_OK | fs.constants.W_OK);
    } catch (e: any) {
      status = 'fail';
      msg = `Cannot access: ${d.path} (${e.message})`;
    }

    checks.push({
      name: d.label,
      status,
      message: msg
    });
  }

  // 4. Registry Connectivity & Config
  const npmrc = loadNpmrc(projectRoot);
  try {
    const start = Date.now();
    const res = await fetch(npmrc.registry, { method: 'HEAD', signal: AbortSignal.timeout(4000) });
    const latency = Date.now() - start;
    checks.push({
      name: 'Registry Connectivity',
      status: res.ok ? 'pass' : 'warn',
      message: `${npmrc.registry} (${latency}ms)`
    });
  } catch (err: any) {
    checks.push({
      name: 'Registry Connectivity',
      status: 'warn',
      message: `Failed to ping ${npmrc.registry} (${err.message})`,
      details: 'Check internet connection or offline mode'
    });
  }

  // 5. Project package.json
  const pkgPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = readPackageJson(projectRoot);
      const depCount = Object.keys(pkg.dependencies || {}).length;
      const devDepCount = Object.keys(pkg.devDependencies || {}).length;
      checks.push({
        name: 'Project package.json',
        status: 'pass',
        message: `Valid (${depCount} deps, ${devDepCount} devDeps)`
      });
    } catch {
      checks.push({
        name: 'Project package.json',
        status: 'fail',
        message: 'Invalid JSON syntax'
      });
    }
  }

  // 6. Lockfile health
  const lockfilePath = path.join(projectRoot, LOCKFILE_NAME);
  if (fs.existsSync(lockfilePath)) {
    const lock = readLockfile(projectRoot);
    if (lock) {
      checks.push({
        name: 'Lockfile Health',
        status: 'pass',
        message: `${LOCKFILE_NAME} (v${lock.lockfileVersion}, ${Object.keys(lock.packages).length} packages)`
      });
    } else {
      checks.push({
        name: 'Lockfile Health',
        status: 'fail',
        message: `${LOCKFILE_NAME} is corrupt or unreadable`
      });
    }
  }

  // 7. IDE & TypeScript Language Server LSP Configuration
  if (options.fix) {
    initIdeConfig(projectRoot);
  }
  const ideDiag = checkIdeDiagnostics(projectRoot);
  if (ideDiag.isReady) {
    checks.push({
      name: 'IDE & TypeScript LSP',
      status: 'pass',
      message: 'Configured (.vscode/settings.json + preserveSymlinks)'
    });
  } else {
    checks.push({
      name: 'IDE & TypeScript LSP',
      status: 'warn',
      message: 'Not optimized for store junctions / symlinks',
      details: `Run "linkpm ide-init" or "linkpm doctor --fix" to auto-configure: ${ideDiag.recommendations.join(', ')}`
    });
  }

  return checks;
}

export function printDoctorResults(checks: DiagnosticCheck[]): void {
  console.log(pc.bold('\n🩺 LinkPM Environment Diagnostics:\n'));

  for (const check of checks) {
    let icon = pc.green('✔');
    if (check.status === 'warn') icon = pc.yellow('⚠');
    if (check.status === 'fail') icon = pc.red('✖');

    console.log(`  ${icon} ${pc.bold(check.name)}: ${check.message}`);
    if (check.details) {
      console.log(`    ${pc.dim(check.details)}`);
    }
  }
  console.log('');
}
