---
name: linkpm
description: Fast JS/TS package management with central content-addressable store, NTFS junctions, MCP discovery, and supply-chain verification
---

# LinkPM — Agent Skill

This skill guides AI agents on how to use and diagnose **LinkPM** (`linkpm`), a modern, high-performance JavaScript/TypeScript package manager.

## Core Architecture & Concepts
- **Global Content-Addressable Store**: Packages are extracted once into `~/.linkpm/store/<pkg>@<ver>/` and linked into projects using zero-copy NTFS junctions (Windows) or symlinks (macOS/Linux).
- **Strict Isolation**: Direct dependencies are linked into `node_modules/`, while transitive dependencies are isolated inside `node_modules/.linkpm/` to prevent phantom dependency bugs.
- **Native AI Integration**: LinkPM automatically discovers MCP (Model Context Protocol) servers and Agent Skills declared by packages and wires them into `.cursor/mcp.json`, `mcp_config.json`, and `.agents/skills/`.

---

## When to Use LinkPM
Use `linkpm` whenever you need to:
1. Install, add, or update Node.js packages in a workspace.
2. Troubleshoot symlinks, TypeScript LSP "Go to Definition", or IDE auto-import issues.
3. Configure React Native / Metro bundlers to follow symlinked packages.
4. Manage disk space and garbage-collect unreferenced dependencies.
5. Discover or synchronize MCP servers and agent skills.

---

## Command Reference

### 1. Installation & Dependency Management
```bash
# Install all dependencies from package.json and linkpm-lock.json
linkpm install

# Install with automatic AI capability discovery (MCP servers & skills)
linkpm install --ai

# Strict CI mode: fail if lockfile is out of sync or packages need resolution
linkpm install --frozen

# Production mode: skip devDependencies for lean container builds
linkpm install --production

# Add direct dependency
linkpm add <package-name>
linkpm add <package-name>@<version>

# Add development dependency
linkpm add -D <package-name>

# Remove a dependency
linkpm remove <package-name>
```

### 2. Linker Modes & Mobile / React Native
LinkPM uses **hoisted mode by default**, creating a flat, hardlinked `node_modules/` that guarantees 100% compatibility with Node.js module resolution, Express, Webpack, Metro, and CocoaPods:
```bash
# Default mode is already hoisted (flat node_modules layout)
linkpm install

# Strict isolated mode (NTFS junctions on Windows / symlinks on Unix)
linkpm install --linker junction

# Automatically configure metro.config.js for React Native symlinks if needed
linkpm metro-init
```

### 3. IDE Integration & Diagnostics
When TypeScript auto-completion or "Go to definition" does not resolve symlinks in VS Code or Cursor:
```bash
# Check runtime health, registry ping, store integrity, and IDE settings
linkpm doctor

# Automatically repair IDE path mappings and generate .vscode/settings.json
linkpm doctor --fix

# Directly initialize .vscode/settings.json (typescript.tsdk and preserveSymlinks)
linkpm ide-init
```

### 4. AI Capabilities (MCP Servers & Skills)
```bash
# List all active MCP servers and Agent Skills registered in the project
linkpm ai list

# Scan node_modules and synchronize any newly discovered MCP servers/skills
linkpm ai sync

# Clean up stale or uninstalled MCP servers and skills from IDE configs
linkpm ai clean
```

### 5. Central Store & Disk Management
```bash
# View store size, total packages, and junction statistics
linkpm store status

# Clean up unreferenced and orphaned package versions to reclaim disk space
linkpm store gc

# Verify cryptographic SHA-512 integrity of all stored packages
linkpm store verify
```

### 6. Security & Audit
```bash
# Audit dependencies against npm security advisory database
linkpm audit

# Approve an unreviewed postinstall script
linkpm approve <package-name>
```

---

## Troubleshooting Guide for Agents

- **TypeScript IDE errors / "Cannot find module" on symlinks**:
  - Run `linkpm doctor --fix` or `linkpm ide-init`.
  - Ensures `.vscode/settings.json` has `"typescript.tsdk": "node_modules/typescript/lib"` and `"typescript.preferences.includePackageJsonAutoImports": "auto"`.
  - Verifies `tsconfig.json` has `"compilerOptions": { "preserveSymlinks": true }`.

- **React Native / Expo "Unable to resolve module"**:
  - Run `linkpm metro-init`.
  - Or reinstall using `linkpm install --linker hoisted`.

- **Lockfile Out of Sync in CI**:
  - Run `linkpm install` locally to update `linkpm-lock.json` and commit the changes.
