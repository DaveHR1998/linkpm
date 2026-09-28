import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  detectAICapabilities,
  readProjectAIRegistry,
  writeProjectAIRegistry,
  syncToIDEConfigs,
  removeAICapabilityFromConfigs,
  registerAICapabilities,
  scanAndSyncAllAICapabilities
} from '../src/ai/index.js';

test('AI Detection: discovers conventional @modelcontextprotocol/* MCP server packages', () => {
  const tmpDir = path.join(os.tmpdir(), `linkpm-ai-det-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({
      name: '@modelcontextprotocol/server-filesystem',
      version: '0.6.2',
      description: 'Filesystem MCP server',
      bin: {
        'mcp-server-filesystem': './dist/index.js'
      }
    })
  );

  const caps = detectAICapabilities(tmpDir, '@modelcontextprotocol/server-filesystem');
  assert.equal(caps.hasCapabilities, true);
  assert.ok(caps.mcpServers['server-filesystem']);
  assert.equal(caps.mcpServers['server-filesystem'].command, 'node');
  assert.ok(caps.mcpServers['server-filesystem'].args[0].endsWith('dist' + path.sep + 'index.js'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('AI Detection: discovers community MCP packages ending with -mcp and keywords ["mcp"]', () => {
  const tmpDir = path.join(os.tmpdir(), `linkpm-ai-comm-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({
      name: 'notebooklm-mcp',
      version: '2.0.0',
      description: 'MCP server for Google NotebookLM',
      keywords: ['mcp', 'notebooklm', 'gemini'],
      bin: {
        'notebooklm-mcp': 'dist/index.js'
      },
      dependencies: {
        '@modelcontextprotocol/sdk': '^1.0.0'
      }
    })
  );

  const caps = detectAICapabilities(tmpDir, 'notebooklm-mcp');
  assert.equal(caps.hasCapabilities, true);
  assert.ok(caps.mcpServers['notebooklm']);
  assert.equal(caps.mcpServers['notebooklm'].command, 'node');
  assert.ok(caps.mcpServers['notebooklm'].args[0].endsWith('dist' + path.sep + 'index.js'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('AI Detection: discovers explicit "ai" and "mcp" fields in package.json', () => {
  const tmpDir = path.join(os.tmpdir(), `linkpm-ai-exp-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({
      name: 'my-custom-ai-tool',
      version: '1.0.0',
      ai: {
        name: 'custom-mcp',
        command: 'node',
        args: ['./dist/server.js'],
        description: 'Custom AI MCP server'
      }
    })
  );

  const caps = detectAICapabilities(tmpDir, 'my-custom-ai-tool');
  assert.equal(caps.hasCapabilities, true);
  assert.ok(caps.mcpServers['custom-mcp']);
  assert.equal(caps.mcpServers['custom-mcp'].command, 'node');
  assert.ok(caps.mcpServers['custom-mcp'].args[0].endsWith('dist' + path.sep + 'server.js'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('AI Detection: discovers Agent Skills in skills/<skill>/SKILL.md', () => {
  const tmpDir = path.join(os.tmpdir(), `linkpm-ai-skill-${Date.now()}`);
  const skillDir = path.join(tmpDir, 'skills', 'code-auditor');
  fs.mkdirSync(skillDir, { recursive: true });

  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({
      name: 'developer-skills',
      version: '1.0.0'
    })
  );

  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---
name: code-auditor
description: Audits code quality and vulnerabilities
---
# Instructions
Analyze the code.
`
  );

  const caps = detectAICapabilities(tmpDir, 'developer-skills');
  assert.equal(caps.hasCapabilities, true);
  assert.equal(caps.skills.length, 1);
  assert.equal(caps.skills[0].name, 'code-auditor');
  assert.equal(caps.skills[0].description, 'Audits code quality and vulnerabilities');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('AI Registration & Sync: synchronizes to .cursor/mcp.json and mcp_config.json', async () => {
  const tmpProject = path.join(os.tmpdir(), `linkpm-ai-proj-${Date.now()}`);
  const fakePkgDir = path.join(os.tmpdir(), `linkpm-ai-pkg-${Date.now()}`);

  fs.mkdirSync(tmpProject, { recursive: true });
  fs.mkdirSync(fakePkgDir, { recursive: true });

  fs.writeFileSync(
    path.join(fakePkgDir, 'package.json'),
    JSON.stringify({
      name: '@modelcontextprotocol/server-postgres',
      version: '1.0.0',
      bin: { 'server-postgres': 'bin.js' }
    })
  );

  // Register capabilities with explicit approval
  const res = await registerAICapabilities(tmpProject, fakePkgDir, '@modelcontextprotocol/server-postgres', { yes: true });
  assert.equal(res.capability.hasCapabilities, true);
  assert.equal(res.approved, true);
  assert.ok(res.serversRegistered.includes('server-postgres'));

  // 1. Verify .linkpm/ai.json
  const registry = readProjectAIRegistry(tmpProject);
  assert.ok(registry.servers['server-postgres']);
  assert.ok(registry.servers['server-postgres'].approvedHash);

  // 2. Verify .cursor/mcp.json
  const cursorFile = path.join(tmpProject, '.cursor', 'mcp.json');
  assert.ok(fs.existsSync(cursorFile));
  const cursorData = JSON.parse(fs.readFileSync(cursorFile, 'utf-8'));
  assert.ok(cursorData.mcpServers['server-postgres']);

  // 3. Verify mcp_config.json
  const rootMcpFile = path.join(tmpProject, 'mcp_config.json');
  assert.ok(fs.existsSync(rootMcpFile));
  const rootData = JSON.parse(fs.readFileSync(rootMcpFile, 'utf-8'));
  assert.ok(rootData.mcpServers['server-postgres']);

  // 4. Test Cleanup on remove
  const removed = removeAICapabilityFromConfigs(tmpProject, '@modelcontextprotocol/server-postgres');
  assert.ok(removed.removedServers.includes('server-postgres'));

  const afterRegistry = readProjectAIRegistry(tmpProject);
  assert.equal(afterRegistry.servers['server-postgres'], undefined);

  const afterCursor = JSON.parse(fs.readFileSync(cursorFile, 'utf-8'));
  assert.equal(afterCursor.mcpServers['server-postgres'], undefined);

  fs.rmSync(tmpProject, { recursive: true, force: true });
  fs.rmSync(fakePkgDir, { recursive: true, force: true });
});

test('AI Scan & Sync: scans node_modules and discovers multiple AI packages', async () => {
  const tmpProject = path.join(os.tmpdir(), `linkpm-ai-scan-${Date.now()}`);
  const nm = path.join(tmpProject, 'node_modules');

  // Package 1: MCP Server
  const pkg1 = path.join(nm, 'mcp-server-git');
  fs.mkdirSync(pkg1, { recursive: true });
  fs.writeFileSync(path.join(pkg1, 'package.json'), JSON.stringify({
    name: 'mcp-server-git',
    version: '0.1.0',
    bin: { 'mcp-server-git': 'cli.js' }
  }));

  // Package 2: Normal non-AI package
  const pkg2 = path.join(nm, 'lodash');
  fs.mkdirSync(pkg2, { recursive: true });
  fs.writeFileSync(path.join(pkg2, 'package.json'), JSON.stringify({
    name: 'lodash',
    version: '4.17.21'
  }));

  const scanRes = await scanAndSyncAllAICapabilities(tmpProject, { yes: true });
  assert.equal(scanRes.packagesScanned, 2);
  assert.equal(scanRes.aiPackagesFound, 1);
  assert.equal(scanRes.serversCount, 1);

  const reg = readProjectAIRegistry(tmpProject);
  assert.ok(reg.servers['git']);

  fs.rmSync(tmpProject, { recursive: true, force: true });
});

test('Security: AI wiring is strictly opt-in and non-interactive environment without --yes declines registration', async () => {
  const tmpProject = path.join(os.tmpdir(), `linkpm-ai-sec-${Date.now()}`);
  const fakePkgDir = path.join(os.tmpdir(), `linkpm-ai-fake-${Date.now()}`);

  fs.mkdirSync(tmpProject, { recursive: true });
  fs.mkdirSync(fakePkgDir, { recursive: true });

  fs.writeFileSync(
    path.join(fakePkgDir, 'package.json'),
    JSON.stringify({
      name: 'evil-mcp',
      version: '1.0.0',
      keywords: ['mcp'],
      bin: { 'evil-mcp': 'attack.js' }
    })
  );

  // Without --yes and in non-interactive mode: must NOT register
  const res = await registerAICapabilities(tmpProject, fakePkgDir, 'evil-mcp', { interactive: false, yes: false });
  assert.equal(res.approved, false);
  assert.equal(res.serversRegistered.length, 0);

  // Verify IDE files were NOT created or modified
  const cursorFile = path.join(tmpProject, '.cursor', 'mcp.json');
  const rootMcpFile = path.join(tmpProject, 'mcp_config.json');
  assert.equal(fs.existsSync(cursorFile), false);
  assert.equal(fs.existsSync(rootMcpFile), false);

  fs.rmSync(tmpProject, { recursive: true, force: true });
  fs.rmSync(fakePkgDir, { recursive: true, force: true });
});

test('Security: Cryptographic approval pinning stores hash and prevents unapproved modifications', async () => {
  const tmpProject = path.join(os.tmpdir(), `linkpm-ai-pin-${Date.now()}`);
  const fakePkgDir = path.join(os.tmpdir(), `linkpm-ai-pinpkg-${Date.now()}`);

  fs.mkdirSync(tmpProject, { recursive: true });
  fs.mkdirSync(fakePkgDir, { recursive: true });

  fs.writeFileSync(
    path.join(fakePkgDir, 'package.json'),
    JSON.stringify({
      name: 'safe-mcp',
      version: '1.0.0',
      bin: { 'safe-mcp': 'index.js' }
    })
  );

  // 1. Initial approved registration
  const res = await registerAICapabilities(tmpProject, fakePkgDir, 'safe-mcp', { yes: true });
  assert.equal(res.approved, true);

  const reg = readProjectAIRegistry(tmpProject);
  const initialHash = reg.servers['safe']?.approvedHash;
  assert.ok(initialHash);

  // 2. Tampering simulation: version updates or binary target changes
  fs.writeFileSync(
    path.join(fakePkgDir, 'package.json'),
    JSON.stringify({
      name: 'safe-mcp',
      version: '2.0.0',
      bin: { 'safe-mcp': 'tampered-evil.js' }
    })
  );

  // Re-registering without approval must be declined because hash changed
  const tamperedRes = await registerAICapabilities(tmpProject, fakePkgDir, 'safe-mcp', { interactive: false, yes: false });
  assert.equal(tamperedRes.approved, false);

  fs.rmSync(tmpProject, { recursive: true, force: true });
  fs.rmSync(fakePkgDir, { recursive: true, force: true });
});

test('Security: syncToIDEConfigs sanitizes environment variables and never leaks host secrets', () => {
  const tmpProject = path.join(os.tmpdir(), `linkpm-ai-secenv-${Date.now()}`);
  fs.mkdirSync(tmpProject, { recursive: true });

  const fakeSecretKey = 'MY_SUPER_SECRET_TOKEN_XYZ';
  process.env[fakeSecretKey] = 'super-secret-12345-value';

  try {
    const registry: any = {
      version: 1,
      servers: {
        'secure-mcp': {
          packageName: 'secure-mcp',
          command: 'node',
          args: ['index.js'],
          env: {
            [fakeSecretKey]: 'super-secret-12345-value',
            'NORMAL_SETTING': 'debug'
          }
        }
      },
      skills: {}
    };

    writeProjectAIRegistry(tmpProject, registry);

    const cursorFile = path.join(tmpProject, '.cursor', 'mcp.json');
    assert.ok(fs.existsSync(cursorFile));
    const cursorData = JSON.parse(fs.readFileSync(cursorFile, 'utf-8'));
    const serverConf = cursorData.mcpServers['secure-mcp'];

    // Verify secret was replaced by placeholder and not leaked
    assert.equal(serverConf.env[fakeSecretKey], `YOUR_${fakeSecretKey}_HERE`);
    assert.equal(serverConf.env['NORMAL_SETTING'], 'debug');
  } finally {
    delete process.env[fakeSecretKey];
    fs.rmSync(tmpProject, { recursive: true, force: true });
  }
});

