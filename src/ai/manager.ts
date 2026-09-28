import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { detectAICapabilities, AICapability } from './detector.js';
import {
  readProjectAIRegistry,
  writeProjectAIRegistry,
  removeAICapabilityFromConfigs,
  syncToIDEConfigs,
  ProjectAIRegistry
} from './config.js';

export interface RegisterAIResult {
  packageName: string;
  serversRegistered: string[];
  skillsRegistered: string[];
  capability: AICapability;
}

/**
 * Discovers and registers AI capabilities from a package into the project.
 */
export function registerAICapabilities(
  projectRoot: string,
  packageDir: string,
  packageName?: string
): RegisterAIResult {
  const capability = detectAICapabilities(packageDir, packageName);
  const registry = readProjectAIRegistry(projectRoot);

  const serversRegistered: string[] = [];
  const skillsRegistered: string[] = [];

  // Register MCP servers
  for (const [serverName, serverConf] of Object.entries(capability.mcpServers)) {
    registry.servers[serverName] = {
      ...serverConf,
      packageName: capability.packageName
    };
    serversRegistered.push(serverName);
  }

  // Register Agent Skills
  for (const skill of capability.skills) {
    registry.skills[skill.name] = {
      packageName: capability.packageName,
      sourceDir: skill.skillDir,
      description: skill.description
    };
    skillsRegistered.push(skill.name);
  }

  if (capability.hasCapabilities) {
    writeProjectAIRegistry(projectRoot, registry);
  }

  return {
    packageName: capability.packageName,
    serversRegistered,
    skillsRegistered,
    capability
  };
}

/**
 * Scans all installed packages in node_modules and registers any discovered AI capabilities.
 */
export function scanAndSyncAllAICapabilities(projectRoot: string): {
  packagesScanned: number;
  aiPackagesFound: number;
  serversCount: number;
  skillsCount: number;
} {
  const nmDir = path.join(projectRoot, 'node_modules');
  if (!fs.existsSync(nmDir)) {
    return { packagesScanned: 0, aiPackagesFound: 0, serversCount: 0, skillsCount: 0 };
  }

  let packagesScanned = 0;
  let aiPackagesFound = 0;

  const entries = fs.readdirSync(nmDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.bin' || entry.name.startsWith('.')) continue;

    if (entry.name.startsWith('@')) {
      const scopeDir = path.join(nmDir, entry.name);
      if (fs.existsSync(scopeDir) && fs.statSync(scopeDir).isDirectory()) {
        const scopedEntries = fs.readdirSync(scopeDir, { withFileTypes: true });
        for (const scopedEntry of scopedEntries) {
          if (scopedEntry.isDirectory()) {
            packagesScanned++;
            const fullPkgName = `${entry.name}/${scopedEntry.name}`;
            const pkgDir = path.join(scopeDir, scopedEntry.name);
            const res = registerAICapabilities(projectRoot, pkgDir, fullPkgName);
            if (res.capability.hasCapabilities) aiPackagesFound++;
          }
        }
      }
    } else if (entry.isDirectory()) {
      packagesScanned++;
      const pkgDir = path.join(nmDir, entry.name);
      const res = registerAICapabilities(projectRoot, pkgDir, entry.name);
      if (res.capability.hasCapabilities) aiPackagesFound++;
    }
  }

  const registry = readProjectAIRegistry(projectRoot);
  const serversCount = Object.keys(registry.servers).length;
  const skillsCount = Object.keys(registry.skills).length;

  return {
    packagesScanned,
    aiPackagesFound,
    serversCount,
    skillsCount
  };
}

/**
 * Pretty prints all active AI capabilities in the project.
 */
export function printAICapabilities(registry: ProjectAIRegistry): void {
  const serverCount = Object.keys(registry.servers).length;
  const skillCount = Object.keys(registry.skills).length;

  console.log(pc.bold(pc.blue('\n🤖 Project AI Capabilities & Agent Tooling:')));

  if (serverCount === 0 && skillCount === 0) {
    console.log(pc.dim('  No AI capabilities or MCP servers currently registered.'));
    console.log(pc.dim('  Install an AI package with: ') + pc.cyan('linkpm add @modelcontextprotocol/server-postgres --ai\n'));
    return;
  }

  if (serverCount > 0) {
    console.log(pc.bold(`\n  🔌 MCP Servers (${serverCount}):`));
    for (const [name, s] of Object.entries(registry.servers)) {
      console.log(`    ${pc.bold(pc.cyan(name))} ${pc.dim(`[from ${s.packageName}]`)}`);
      console.log(`      ${pc.dim('command:')} ${s.command} ${s.args.join(' ')}`);
      if (s.description) console.log(`      ${pc.dim('desc:')}    ${s.description}`);
    }
  }

  if (skillCount > 0) {
    console.log(pc.bold(`\n  🧠 Agent Skills (${skillCount}):`));
    for (const [name, skill] of Object.entries(registry.skills)) {
      console.log(`    ${pc.bold(pc.magenta(name))} ${pc.dim(`[from ${skill.packageName}]`)}`);
      if (skill.description) console.log(`      ${pc.dim('desc:')} ${skill.description}`);
      console.log(`      ${pc.dim('path:')} ${skill.sourceDir}`);
    }
  }

  console.log(pc.dim('\nSynchronized to: .cursor/mcp.json, mcp_config.json, and .agents/skills/\n'));
}

export { removeAICapabilityFromConfigs };
