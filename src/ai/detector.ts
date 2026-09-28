import fs from 'node:fs';
import path from 'node:path';

export interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  description?: string;
  tools?: string[];
  type?: 'stdio' | 'sse';
  url?: string;
}

export interface AgentSkillManifest {
  name: string;
  description?: string;
  skillDir: string;
  skillMdPath: string;
}

export interface AICapability {
  packageName: string;
  version: string;
  packageDir: string;
  mcpServers: Record<string, MCPServerConfig>;
  skills: AgentSkillManifest[];
  hasCapabilities: boolean;
}

/**
 * Inspects an installed package directory to discover AI capabilities:
 * 1. Explicit package.json "ai" or "mcp" fields.
 * 2. Conventional MCP definitions (mcp.json, bin entry for @modelcontextprotocol/*).
 * 3. Conventional Agent Skills (skills/<name>/SKILL.md).
 */
export function detectAICapabilities(packageDir: string, packageName?: string): AICapability {
  const resolvedDir = path.resolve(packageDir);
  const pkgJsonPath = path.join(resolvedDir, 'package.json');

  let pkgJson: any = {};
  if (fs.existsSync(pkgJsonPath)) {
    try {
      pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    } catch {}
  }

  const name = packageName || pkgJson.name || path.basename(resolvedDir);
  const version = pkgJson.version || '1.0.0';
  const mcpServers: Record<string, MCPServerConfig> = {};
  const skills: AgentSkillManifest[] = [];

  // 1. Explicit "ai" or "mcp" declaration in package.json
  const aiDecl = pkgJson.ai || pkgJson.mcp;
  if (aiDecl && typeof aiDecl === 'object') {
    // If declared as mcpServers object
    if (aiDecl.mcpServers && typeof aiDecl.mcpServers === 'object') {
      for (const [serverName, serverConf] of Object.entries<any>(aiDecl.mcpServers)) {
        mcpServers[serverName] = normalizeMCPServer(serverName, serverConf, resolvedDir);
      }
    } else if (aiDecl.command || aiDecl.args || aiDecl.entry) {
      // Single MCP server declared at root of ai object
      const serverName = aiDecl.name || getSimplePackageName(name);
      mcpServers[serverName] = normalizeMCPServer(serverName, aiDecl, resolvedDir);
    }
  }

  // 2. Check for mcp.json in root of package
  const mcpJsonPath = path.join(resolvedDir, 'mcp.json');
  if (fs.existsSync(mcpJsonPath)) {
    try {
      const rawMcp = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
      if (rawMcp.mcpServers) {
        for (const [sName, sConf] of Object.entries<any>(rawMcp.mcpServers)) {
          mcpServers[sName] = normalizeMCPServer(sName, sConf, resolvedDir);
        }
      } else if (rawMcp.command || rawMcp.args) {
        const sName = rawMcp.name || getSimplePackageName(name);
        mcpServers[sName] = normalizeMCPServer(sName, rawMcp, resolvedDir);
      }
    } catch {}
  }

  // 3. Conventional MCP server: @modelcontextprotocol/* or package keyword "mcp-server"
  const isMcpPackage =
    name.startsWith('@modelcontextprotocol/') ||
    name.startsWith('mcp-server-') ||
    (Array.isArray(pkgJson.keywords) && pkgJson.keywords.includes('mcp-server'));

  if (isMcpPackage && Object.keys(mcpServers).length === 0) {
    const serverName = getSimplePackageName(name);
    // Find bin entry or main entry
    let targetScript: string | null = null;
    if (typeof pkgJson.bin === 'string') {
      targetScript = pkgJson.bin;
    } else if (pkgJson.bin && typeof pkgJson.bin === 'object') {
      targetScript = pkgJson.bin[serverName] || Object.values(pkgJson.bin)[0] as string;
    } else if (pkgJson.main) {
      targetScript = pkgJson.main;
    }

    if (targetScript) {
      const absScript = path.resolve(resolvedDir, targetScript);
      mcpServers[serverName] = {
        name: serverName,
        command: 'node',
        args: [absScript],
        description: pkgJson.description || `Model Context Protocol server for ${name}`
      };
    }
  }

  // 4. Discover Agent Skills in package: skills/<skill_name>/SKILL.md or skills/SKILL.md
  const skillsBaseDir = path.join(resolvedDir, 'skills');
  if (fs.existsSync(skillsBaseDir) && fs.statSync(skillsBaseDir).isDirectory()) {
    // Check if skills/SKILL.md is directly in skills/
    const directSkillMd = path.join(skillsBaseDir, 'SKILL.md');
    if (fs.existsSync(directSkillMd)) {
      skills.push({
        name: getSimplePackageName(name),
        description: parseSkillDescription(directSkillMd),
        skillDir: skillsBaseDir,
        skillMdPath: directSkillMd
      });
    } else {
      // Check subdirectories
      const entries = fs.readdirSync(skillsBaseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subSkillMd = path.join(skillsBaseDir, entry.name, 'SKILL.md');
          if (fs.existsSync(subSkillMd)) {
            skills.push({
              name: entry.name,
              description: parseSkillDescription(subSkillMd),
              skillDir: path.join(skillsBaseDir, entry.name),
              skillMdPath: subSkillMd
            });
          }
        }
      }
    }
  }

  const hasCapabilities = Object.keys(mcpServers).length > 0 || skills.length > 0;

  return {
    packageName: name,
    version,
    packageDir: resolvedDir,
    mcpServers,
    skills,
    hasCapabilities
  };
}

function normalizeMCPServer(name: string, raw: any, baseDir: string): MCPServerConfig {
  let command = raw.command || 'node';
  let rawArgs: string[] = Array.isArray(raw.args) ? raw.args : [];

  if (raw.entry && rawArgs.length === 0) {
    rawArgs = [raw.entry];
  }

  // Resolve relative paths in arguments against baseDir
  const resolvedArgs = rawArgs.map(arg => {
    if (typeof arg === 'string' && (arg.endsWith('.js') || arg.endsWith('.mjs') || arg.endsWith('.cjs') || arg.endsWith('.ts'))) {
      if (!path.isAbsolute(arg)) {
        return path.resolve(baseDir, arg);
      }
    }
    return arg;
  });

  return {
    name,
    command,
    args: resolvedArgs,
    env: raw.env || undefined,
    description: raw.description,
    tools: Array.isArray(raw.tools) ? raw.tools : undefined,
    type: raw.type || 'stdio',
    url: raw.url
  };
}

function getSimplePackageName(pkgName: string): string {
  if (pkgName.startsWith('@')) {
    const parts = pkgName.split('/');
    return parts[1] || pkgName;
  }
  return pkgName.replace(/^mcp-server-/, '');
}

function parseSkillDescription(skillMdPath: string): string | undefined {
  try {
    const content = fs.readFileSync(skillMdPath, 'utf-8');
    const yamlMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (yamlMatch) {
      const descMatch = yamlMatch[1].match(/description:\s*([^\r\n]+)/i);
      if (descMatch) return descMatch[1].trim().replace(/^['"]|['"]$/g, '');
    }
    // Fallback: first non-header line
    const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (!line.startsWith('#') && !line.startsWith('---')) {
        return line.slice(0, 120);
      }
    }
  } catch {}
  return undefined;
}
