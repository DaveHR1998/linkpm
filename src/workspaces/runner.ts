import pc from 'picocolors';
import { findWorkspaceRoot } from './config.js';
import { discoverWorkspacePackages, WorkspacePackage } from './discovery.js';
import { filterWorkspacePackages, sortWorkspacePackagesTopologically } from './topo.js';
import { runScript } from '../scripts/runner.js';
import { LinkPMError } from '../utils/errors.js';

export interface WorkspaceRunOptions {
  filter?: string;
  extraArgs?: string[];
  ifPresent?: boolean;
}

export async function runWorkspaceScript(
  scriptName: string,
  options: WorkspaceRunOptions = {}
): Promise<number> {
  const rootConfig = findWorkspaceRoot();
  if (!rootConfig) {
    throw new LinkPMError('No workspace configuration (pnpm-workspace.yaml or package.json workspaces) found', {
      code: 'ERR_PROJECT_NOT_FOUND',
      hint: 'Add "workspaces": ["packages/*"] to package.json or create pnpm-workspace.yaml.'
    });
  }

  const allPackages = discoverWorkspacePackages(rootConfig.root, rootConfig.globs);
  if (allPackages.length === 0) {
    console.log(pc.yellow('No workspace packages found matching workspace globs: ' + rootConfig.globs.join(', ')));
    return 0;
  }

  const filtered = filterWorkspacePackages(allPackages, options.filter);
  if (filtered.length === 0) {
    console.log(pc.yellow(`No workspace packages matched filter: "${options.filter}"`));
    return 0;
  }

  const sorted = sortWorkspacePackagesTopologically(filtered);

  console.log(
    pc.bold(pc.blue('⚡ linkpm workspace:')) +
    ` Running "${pc.bold(scriptName)}" across ${pc.cyan(sorted.length.toString())} package(s) in topological order...\n`
  );

  for (const pkg of sorted) {
    const hasScript = Boolean(pkg.pkgJson.scripts && pkg.pkgJson.scripts[scriptName]);
    if (!hasScript && options.ifPresent) {
      continue;
    }

    console.log(`\n${pc.bold(pc.cyan(`▶ ${pkg.name}`))}${pc.dim(` (${pkg.directory})`)}`);

    const result = await runScript(pkg.directory, scriptName, {
      extraArgs: options.extraArgs,
      ifPresent: options.ifPresent
    });

    if (!result.success) {
      console.error(pc.red(`\n✖ Script "${scriptName}" failed in package ${pkg.name} with code ${result.exitCode}`));
      return result.exitCode || 1;
    }
  }

  console.log(pc.bold(pc.green(`\n✔ Successfully finished "${scriptName}" across all workspace packages.`)));
  return 0;
}
