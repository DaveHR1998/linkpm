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
- **Supply-Chain & Cooldown Defense**: 24h release-age cooldown (`minimumReleaseAge`) protects against day-zero account takeovers, falling back to the newest cooldown-safe release. Default-deny lifecycle script execution prevents unauthorized postinstall script exploits.

---

## When to Use LinkPM
Use `linkpm` whenever you need to:
1. Install, add, list, or update Node.js packages in a workspace or globally.
2. Run project lifecycle scripts (`linkpm dev`, `linkpm build`, `linkpm test`, `linkpm run`).
3. Troubleshoot symlinks, TypeScript LSP "Go to Definition", or IDE auto-import issues.
4. Configure React Native / Metro bundlers to follow symlinked packages.
5. Manage disk space and garbage-collect unreferenced dependencies.
6. Discover or synchronize MCP servers and agent skills.

---

## Command Reference

### 1. Installation & Dependency Management
```bash
# Install all dependencies from package.json and linkpm-lock.json
linkpm install
linkpm i

# Install with automatic AI capability discovery (MCP servers & skills)
linkpm install --ai

# Strict CI mode: fail if lockfile is out of sync or packages need resolution
linkpm ci
linkpm install --frozen
linkpm install --frozen-lockfile

# Production mode: skip devDependencies for lean container builds
linkpm install --prod
linkpm ci --prod

# Add direct dependency (linkpm install <pkg> also aliases linkpm add)
linkpm add <package-name>
linkpm add <package-name>@<version>
linkpm install <package-name>

# Add development dependency
linkpm add -D <package-name>

# Global packages (pnpm add -g parity, binaries staged in ~/.linkpm/bin)
linkpm add -g <package-name>
linkpm remove -g <package-name>

# List installed top-level packages and their resolved versions
linkpm list
linkpm ls

# Remove a dependency
linkpm remove <package-name>
linkpm rm <package-name>

# Update dependencies to latest compatible versions
linkpm update
linkpm update <package-name>
```

### 2. Lifecycle Scripts & Execution
```bash
# Direct script shorthands (pnpm parity)
linkpm dev
linkpm build
linkpm test
linkpm start

# Run arbitrary scripts with arguments and flags
linkpm run <script> -- <args>
linkpm run lint --if-present

# Execute local binaries from node_modules/.bin
linkpm exec <command> [...args]

# Run a remote package binary without installing (npx / pnpm dlx parity)
linkpm dlx <package-name> [...args]
```

### 3. Linker Modes & Mobile / React Native
LinkPM uses **junction mode by default**, creating zero-copy NTFS junctions (Windows) or symlinks (macOS/Linux) that point directly into `~/.linkpm/store/` without duplicating disk space:
```bash
# Default mode: zero-copy junctions (0 MB disk bloat in project)
linkpm install

# Hoisted linker mode: creates flat physical node_modules for React Native / Metro
linkpm install --linker hoisted

# Automatically configure metro.config.js for React Native symlinks if needed
linkpm metro-init
```

### 4. IDE Integration & Diagnostics
When TypeScript auto-completion or "Go to definition" does not resolve symlinks in VS Code or Cursor:
```bash
# Check runtime health, registry ping, store integrity, and IDE settings
linkpm doctor

# Automatically repair IDE path mappings and generate .vscode/settings.json
linkpm doctor --fix

# Directly initialize .vscode/settings.json (typescript.tsdk and preserveSymlinks)
linkpm ide-init

# View visual ASCII dependency tree
linkpm tree

# Explain why a package is present in the dependency tree
linkpm why <package-name>

# Check for outdated packages
linkpm outdated
```

### 5. AI Capabilities (MCP Servers & Skills)
```bash
# List all active MCP servers and Agent Skills registered in the project
linkpm ai list

# Scan node_modules and synchronize any newly discovered MCP servers/skills
linkpm ai sync

# Remove an AI capability and clean up configurations
linkpm ai remove <capability-name>
```

### 6. Central Store & Disk Management
```bash
# View store size, total packages, and junction statistics
linkpm store status

# List all stored packages and versions
linkpm store list

# Show active store directory path
linkpm store path

# Garbage collect unreferenced packages (with 30-day retention grace period)
linkpm store gc
linkpm store prune        # alias of store gc (pnpm store prune parity)

# Dry-run garbage collection preview
linkpm store gc --dry-run

# Bypass 30-day grace period and prune immediately
linkpm store gc --force

# Verify cryptographic SHA-512 integrity of all stored packages
linkpm store verify

# Verify store and auto-repair corrupted packages from verified tarballs
linkpm store verify --fix

# Purge entire central store
linkpm store clear
```

### 7. Security, Supply-Chain & Self-Update
```bash
# Audit dependencies against npm security advisory database
linkpm audit
linkpm audit --format sarif -o audit.sarif

# Inspect and approve package build scripts under default-deny policy
linkpm approve-builds
linkpm approve-builds -y

# Bypass security cooldown for urgent zero-day hotfixes
linkpm install --ignore-release-age

# Allow exotic transitive dependencies (git, tarballs, local paths)
linkpm install --allow-exotic-transitive

# Update linkpm itself to the latest release
linkpm self-update
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

- **Postinstall script blocked**:
  - Run `linkpm approve-builds` to review and approve required native builds.
