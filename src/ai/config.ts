import fs from 'node:fs';
import path from 'node:path';
import { MCPServerConfig, AgentSkillManifest, AICapability } from './detector.js';

export interface ProjectAIRegistry {
  version: 1;
  servers: Record<string, MCPServerConfig & { packageName: string }>;
  skills: Record<string, { packageName: string; sourceDir: string; description?: string }>;
}

export const LINKPM_AI_FILE = '.linkpm/ai.json';

/**
 * Returns the path to the internal LinkPM AI registry file.
 */
export function getLinkPMAIFilePath(projectRoot: string): string {
  return path.join(projectRoot, '.linkpm', 'ai.json');
}

/**
 * Reads the project's LinkPM AI registry.
 */
export function readProjectAIRegistry(projectRoot: string): ProjectAIRegistry {
  const filePath = getLinkPMAIFilePath(projectRoot);
  if (!fs.existsSync(filePath)) {
    return { version: 1, servers: {}, skills: {} };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return {
      version: 1,
      servers: raw.servers || {},
      skills: raw.skills || {}
    };
  } catch {
    return { version: 1, servers: {}, skills: {} };
  }
}

/**
 * Saves the project's LinkPM AI registry and synchronizes it to IDE config targets.
 */
export function writeProjectAIRegistry(projectRoot: string, registry: ProjectAIRegistry): void {
  const filePath = getLinkPMAIFilePath(projectRoot);
  const parentDir = path.dirname(filePath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  fs.writeFileSync(filePath, JSON.stringify(registry, null, 2) + '\n', 'utf-8');

  // Synchronize to IDE configs
  syncToIDEConfigs(projectRoot, registry);
}

/**
 * Automatically propagates registered MCP servers and skills to:
 * 1. .cursor/mcp.json (Cursor IDE)
 * 2. mcp_config.json (Antigravity IDE & Gemini)
 * 3. .agents/skills/ (Workspace Agent Skills)
 */
export function syncToIDEConfigs(projectRoot: string, registry: ProjectAIRegistry): void {
  const mcpServersMap: Record<string, any> = {};

  for (const [serverName, server] of Object.entries(registry.servers)) {
    // Sanitize env: never copy shell secrets or ambient process.env values into configs
    let sanitizedEnv: Record<string, string> | undefined;
    if (server.env && typeof server.env === 'object') {
      sanitizedEnv = {};
      for (const [k, v] of Object.entries(server.env)) {
        if (typeof v === 'string') {
          // Never leak actual secret values from process.env into IDE config files
          if (process.env[k] && v === process.env[k] && v.length > 3) {
            sanitizedEnv[k] = `YOUR_${k}_HERE`;
          } else {
            sanitizedEnv[k] = v;
          }
        }
      }
    }

    mcpServersMap[serverName] = {
      command: server.command,
      args: server.args,
      ...(sanitizedEnv && Object.keys(sanitizedEnv).length > 0 ? { env: sanitizedEnv } : {})
    };
  }

  // 1. Sync to .cursor/mcp.json
  const cursorDir = path.join(projectRoot, '.cursor');
  const cursorMcpFile = path.join(cursorDir, 'mcp.json');
  try {
    if (!fs.existsSync(cursorDir)) fs.mkdirSync(cursorDir, { recursive: true });
    let existingCursor: any = {};
    if (fs.existsSync(cursorMcpFile)) {
      try { existingCursor = JSON.parse(fs.readFileSync(cursorMcpFile, 'utf-8')); } catch {}
    }
    existingCursor.mcpServers = { ...(existingCursor.mcpServers || {}), ...mcpServersMap };
    fs.writeFileSync(cursorMcpFile, JSON.stringify(existingCursor, null, 2) + '\n', 'utf-8');
  } catch {}

  // 2. Sync to mcp_config.json (Root level or .gemini/)
  const rootMcpFile = path.join(projectRoot, 'mcp_config.json');
  try {
    let existingRoot: any = {};
    if (fs.existsSync(rootMcpFile)) {
      try { existingRoot = JSON.parse(fs.readFileSync(rootMcpFile, 'utf-8')); } catch {}
    }
    existingRoot.mcpServers = { ...(existingRoot.mcpServers || {}), ...mcpServersMap };
    fs.writeFileSync(rootMcpFile, JSON.stringify(existingRoot, null, 2) + '\n', 'utf-8');
  } catch {}

  // 3. Sync Agent Skills to .agents/skills/
  const workspaceSkillsDir = path.join(projectRoot, '.agents', 'skills');
  if (Object.keys(registry.skills).length > 0) {
    if (!fs.existsSync(workspaceSkillsDir)) {
      fs.mkdirSync(workspaceSkillsDir, { recursive: true });
    }

    for (const [skillName, skillInfo] of Object.entries(registry.skills)) {
      const targetSkillLink = path.join(workspaceSkillsDir, skillName);
      if (fs.existsSync(skillInfo.sourceDir)) {
        if (!fs.existsSync(targetSkillLink)) {
          const linkType = process.platform === 'win32' ? 'junction' : 'dir';
          try {
            fs.symlinkSync(skillInfo.sourceDir, targetSkillLink, linkType);
          } catch {}
        }
      }
    }
  }
}

/**
 * Removes an AI capability and cleans up links across IDE configurations.
 */
export function removeAICapabilityFromConfigs(projectRoot: string, packageName: string): { removedServers: string[]; removedSkills: string[] } {
  const registry = readProjectAIRegistry(projectRoot);
  const removedServers: string[] = [];
  const removedSkills: string[] = [];

  // Remove servers belonging to this package
  for (const [serverName, server] of Object.entries(registry.servers)) {
    if (server.packageName === packageName || serverName === packageName) {
      delete registry.servers[serverName];
      removedServers.push(serverName);
    }
  }

  // Remove skills belonging to this package
  for (const [skillName, skill] of Object.entries(registry.skills)) {
    if (skill.packageName === packageName) {
      const linkPath = path.join(projectRoot, '.agents', 'skills', skillName);
      if (fs.existsSync(linkPath)) {
        try { fs.unlinkSync(linkPath); } catch {
          try { fs.rmdirSync(linkPath); } catch {}
        }
      }
      delete registry.skills[skillName];
      removedSkills.push(skillName);
    }
  }

  // Update .cursor/mcp.json and mcp_config.json
  const cursorMcpFile = path.join(projectRoot, '.cursor', 'mcp.json');
  if (fs.existsSync(cursorMcpFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(cursorMcpFile, 'utf-8'));
      if (data.mcpServers) {
        for (const s of removedServers) delete data.mcpServers[s];
        fs.writeFileSync(cursorMcpFile, JSON.stringify(data, null, 2) + '\n', 'utf-8');
      }
    } catch {}
  }

  const rootMcpFile = path.join(projectRoot, 'mcp_config.json');
  if (fs.existsSync(rootMcpFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(rootMcpFile, 'utf-8'));
      if (data.mcpServers) {
        for (const s of removedServers) delete data.mcpServers[s];
        fs.writeFileSync(rootMcpFile, JSON.stringify(data, null, 2) + '\n', 'utf-8');
      }
    } catch {}
  }

  writeProjectAIRegistry(projectRoot, registry);

  return { removedServers, removedSkills };
}
