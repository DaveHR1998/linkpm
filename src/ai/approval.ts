import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import pc from 'picocolors';
import { AICapability } from './detector.js';

export interface ApprovalOptions {
  yes?: boolean;
  interactive?: boolean;
}

/**
 * Computes a deterministic SHA-256 hash of an MCP server configuration.
 * This pins the approved command and args to detect command tampering or updates.
 */
export function computeMCPServerHash(server: {
  name: string;
  command: string;
  args: string[];
  version?: string;
}): string {
  const payload = `${server.name}:${server.version || ''}:${server.command}:${server.args.join(' ')}`;
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * Prompts the user to review and confirm AI capability registration into IDE configs.
 * Requires explicit confirmation unless --yes is passed.
 * In non-interactive environments (CI), registration is skipped unless --yes is provided.
 */
export async function promptAIApproval(
  packageName: string,
  capability: AICapability,
  options: ApprovalOptions = {}
): Promise<boolean> {
  if (options.yes) {
    console.log(pc.dim(`  ℹ AI capabilities for ${packageName} auto-approved via --yes flag.`));
    return true;
  }

  // Non-interactive check (CI or piped input)
  const isTTY = Boolean(process.stdin.isTTY && !process.env.CI);
  if (!isTTY || options.interactive === false) {
    console.warn(
      pc.yellow(
        `\n⚠️  AI Registration Skipped for "${packageName}":\n` +
        `   Non-interactive environment detected. To automatically approve IDE configuration in CI or scripts, pass --yes (-y).\n`
      )
    );
    return false;
  }

  console.log(pc.bold(pc.yellow(`\n⚠️  AI Capability Registration Confirmation`)));
  console.log(pc.dim('───────────────────────────────────────────────────────────────────'));
  console.log(`Package:     ${pc.bold(packageName)}${capability.version ? `@${capability.version}` : ''}`);
  console.log(`IDE Targets: ${pc.cyan('.cursor/mcp.json')}, ${pc.cyan('mcp_config.json')}, ${pc.cyan('.agents/skills/')}`);

  if (Object.keys(capability.mcpServers).length > 0) {
    console.log(pc.bold('\nMCP Servers to wire:'));
    for (const [sName, sConf] of Object.entries(capability.mcpServers)) {
      console.log(`  • Name:    ${pc.bold(pc.cyan(sName))}`);
      console.log(`    Command: ${pc.green(sConf.command)} ${sConf.args.join(' ')}`);
      if (sConf.env && Object.keys(sConf.env).length > 0) {
        console.log(`    Env:     ${Object.keys(sConf.env).join(', ')}`);
      } else {
        console.log(`    Env:     ${pc.dim('(none)')}`);
      }
    }
  }

  if (capability.skills.length > 0) {
    console.log(pc.bold('\nAgent Skills to link:'));
    for (const skill of capability.skills) {
      console.log(`  • ${pc.bold(skill.name)}: ${pc.dim(skill.description || 'No description')}`);
    }
  }

  console.log(pc.yellow('\nSecurity Notice: MCP servers run as unsandboxed local processes with your user privileges when invoked by your IDE.'));

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(pc.bold('\nAllow this package to register commands in your IDE configs? [y/N]: '));
    const normalized = answer.trim().toLowerCase();
    const approved = normalized === 'y' || normalized === 'yes';

    if (!approved) {
      console.log(pc.yellow(`✖ AI registration declined for "${packageName}". Package remains installed without IDE wiring.\n`));
    }
    return approved;
  } finally {
    rl.close();
  }
}
