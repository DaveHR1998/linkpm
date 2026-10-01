<p align="center">
  <img src="./linkpm.png" alt="LinkPM Logo" width="220" />
</p>

> **High-performance JavaScript & TypeScript package manager powered by a global zero-copy store, isolated virtual dependency mapping, deterministic DAG resolution, transactional rollbacks, and monorepo workspace orchestration.**

[![npm version](https://img.shields.io/npm/v/linkpm.svg)](https://www.npmjs.com/package/linkpm)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)

---

## Core Capabilities

LinkPM is engineered for modern JavaScript and TypeScript development, delivering fast installations, disk deduplication, and project isolation:

- **Global Zero-Copy Store**: Every package version is downloaded and verified with streaming SHA-512 checks **exactly once** in `~/.linkpm/store`. Subsequent installations in any project link instantaneously via directory junctions and symlinks without redownloading.
- **Windows NTFS Junctions & Cross-Drive Freedom**: Utilizes native Windows NTFS Directory Junctions without requiring Administrator privileges or Windows Developer Mode, alongside standard symlinks on Linux and macOS. Seamlessly operates across separate physical drives and dedicated SSD partitions (e.g. `C:` to `D:`).
- **Project-Isolated Virtual Store (`.linkpm/`)**: Sub-dependencies are mapped inside project-local `node_modules/.linkpm/`, ensuring strict isolation between packages without phantom dependencies or cross-project version collisions.
- **In-Place Store Poisoning Immunity**: Store package files are locked with recursive **read-only permissions** (`chmod 0o444` and NTFS `FILE_ATTRIBUTE_READONLY`), preventing accidental developer edits or build tools from mutating the shared global store.
- **Content-Hashed Patch Variants**: Custom patches generated via `linkpm patch` are isolated into `<version>_patch_<hash>` store paths, ensuring different projects or monorepos requiring disparate patches for the same library never collide.
- **Unmounted Drive GC Safety (30-Day Grace Period)**: Garbage collection tracks registered projects with `lastSeen` timestamps and lockfile snapshots. External SSDs or disconnected drive partitions are preserved for 30 days, preventing store cache evictions while drives are unplugged.
- **Atomic Directory Linking**: Links are staged in memory and committed in a transactional phase. If a linking error occurs, LinkPM automatically rolls back staged filesystem links, ensuring `node_modules` is never left in a half-linked state.
- **Monorepos & Workspace Orchestration**: Comprehensive support for `pnpm-workspace.yaml` and `package.json` workspaces, `workspace:*` inter-package links, workspace catalogs, and topological multi-package script execution.
- **One-Command Presets & Scaffolding**: Eliminate repetitive setup with curated stack presets (`frontend`, `backend`, `fastify`, `ui`), full project scaffolding (`linkpm create`), and custom team-saved bundles.
- **AI & Agent Tooling Auto-Wiring (MCP & Skills)**: Native discovery and lifecycle management for Model Context Protocol (MCP) servers and Agent Skills. Packages installed with `--ai` automatically wire IDE assistants (`.cursor/mcp.json`, `mcp_config.json`, `.agents/skills/`) under strict opt-in security with cryptographic command pinning.

---

## 📋 Comprehensive Feature Overview

| Capability | Technical Implementation |
| :--- | :--- |
| **Storage Architecture** | Central content store (`~/.linkpm/store`) + Project Virtual Store (`node_modules/.linkpm/`) |
| **Disk Linking Primitives** | Native NTFS Directory Junctions on Windows (no admin rights needed); Directory symlinks on POSIX |
| **Store Security** | Recursive read-only filesystem attributes (`0o444`) with safe writable unlinking |
| **Patch Management** | Isolated SHA-256 content-hashed store variants (`<version>_patch_<hash>`); binary-safe patches with context verification |
| **Garbage Collection** | Project tracking with 30-day retention grace period for unmounted drives and recent packages |
| **Install Reliability** | Atomic 2-phase directory linking transactions with automatic rollback on linking errors |
| **Dependency Resolution** | Deterministic breadth-first DAG resolver with cycle detection and platform filtering; installs prefer lockfile-pinned versions |
| **Peer Dependencies** | Explicit peer dependency conflict diagnosis and optional peer support |
| **Lockfile Engine** | Version 2 format pinning the **full resolved graph** (top-level + transitive) with exact versions & integrity; strict CI frozen verification; `linkpm ci` never rewrites `package.json` or the lockfile |
| **Registry Config** | Full `.npmrc` support on the real install path: custom registries, scoped registries, mirrors, and auth tokens |
| **Monorepo Workspaces** | Native `pnpm-workspace.yaml` parsing, `workspace:*` linking during install, topological execution runner, and workspace catalogs |
| **Binary Execution** | Triple-shim generation (POSIX shell, Windows CMD, PowerShell) with `--preserve-symlinks` routing |
| **Scaffolding & Presets** | Built-in presets, custom stack persistence (`~/.linkpm/presets.json`), and instant project creation |
| **Diagnostics & Health** | Environment health and diagnostics (`linkpm doctor`), dependency tree, and **real vulnerability auditing** against the npm advisory database (OSV fallback) |
| **AI & Agent Tooling** | Native MCP server discovery, Agent Skills linking, and multi-IDE auto-wiring (.cursor, mcp_config.json) |

---

## 📦 Installation

```bash
npm install -g linkpm
```

Verify your environment and system readiness:
```bash
linkpm doctor
```

---

## 🛠️ Complete CLI Command Reference

### 1. Installation & Dependency Management

```bash
# Install all dependencies from package.json
linkpm install
linkpm i

# Add production dependencies
linkpm add express cors dotenv

# Add development dependencies
linkpm add -D typescript @types/node tsx

# Fast offline-first installs (using local central store)
linkpm add react --prefer-offline
linkpm add react --offline

# Strict CI install from linkpm-lock.json (fails if lockfile is out of sync)
linkpm ci
linkpm install --frozen
linkpm install --frozen-lockfile

# Standalone Serverless & Docker Deployment (copies real files, resolves junctions)
linkpm deploy --out dist-deploy
linkpm deploy --out dist-lambda --prod

# Automatic Lockfile Mirroring:
# linkpm install / add automatically writes both linkpm-lock.json AND a
# package-lock.json (v3) metadata mirror with resolved versions and integrity
# hashes, so tools like Dependabot and Snyk can read pinned dependency data.
# Note: the mirror is a metadata companion for scanners/deploy pipelines, not a
# byte-identical npm tree — LinkPM's own layout uses the central store.

# Remove dependencies and clean node_modules links
linkpm remove lodash axios
linkpm rm express

# Update dependencies against registry manifests
linkpm update
linkpm update express vite

# Security: Inspect and approve package build scripts under default-deny
linkpm approve-builds
linkpm approve-builds -y

# Security bypasses for urgent hotfixes & exotic sources
linkpm install --ignore-release-age
linkpm install --allow-exotic-transitive
```

---

### 2. Dependency Patching Engine

LinkPM features an integrated, isolated patching workflow that protects the global store while allowing customized package modifications:

```bash
# 1. Extract package into a writable temporary editing workspace
linkpm patch lodash

# 2. Make your code changes inside the printed temporary directory
# e.g., edit ~/.linkpm/patching/lodash-4.17.21-xxx/index.js

# 3. Commit your changes (generates patches/lodash@4.17.21.patch and updates package.json)
linkpm patch-commit ~/.linkpm/patching/lodash-4.17.21-xxx
```

Patched packages are compiled into isolated, content-hashed store paths (`lodash/4.17.21_patch_<hash>`), leaving the clean original package untouched.

---

### 3. Mobile & React Native Support (Metro Bundler & Native Builds)

The React Native Metro bundler uses `fs.realpath` during module resolution, which can trigger `"Unable to resolve module react"` when packages reside in global store junctions. LinkPM provides two concrete features to solve this:

#### Option A: Configurable Linker Modes (`linker = hoisted`)
Set `linker = hoisted` in `.linkpmrc` or `package.json`, or pass `--linker hoisted`:

```ini
# .linkpmrc
linker = hoisted   # Classic flat node_modules (copies/hardlinks) for React Native, CocoaPods, and Gradle
# linker = junction # Default: zero-copy store junctions (best for Web & Backend)
```

```bash
# Install dependencies with flat hoisted node_modules
linkpm install --linker hoisted
linkpm add react-native --linker hoisted
```

When `linker = hoisted` is enabled, LinkPM still uses its fast DAG resolver, but places packages flat in `node_modules/` (identical to standard npm layout). Metro, CocoaPods (iOS), and Gradle (Android) work 100% out of the box with zero custom metro configuration!

#### Option B: Zero-Copy Metro Helper (`linkpm metro-init`)
For developers who want to keep instant zero-copy store speeds in React Native:

```bash
linkpm metro-init
```

This automatically configures `metro.config.js`:
- Injects `watchFolders: [linkpmStorePath]` to watch central store packages.
- Enables `resolver.unstable_enableSymlinks: true` and maps project `nodeModulesPaths`.

---

### 4. Monorepos & Workspace Orchestration

LinkPM natively recognizes `pnpm-workspace.yaml` and `package.json` `"workspaces"`:

```bash
# List all discovered workspace packages in the monorepo
linkpm workspace list
linkpm w list

# Link inter-workspace dependencies (e.g., workspace:*, workspace:^)
linkpm workspace link

# Run scripts across all workspace packages in topological order
linkpm run -r build
linkpm run --recursive test

# Filter execution to specific packages or glob patterns
linkpm run --filter @my-org/web-app build
linkpm run --filter "*ui*" build
```

---

### 5. Lifecycle Scripts & Binary Execution

```bash
# Run any package.json script (with pre/post lifecycle hooks and .bin PATH injection)
linkpm run build
linkpm run test -- --watch
linkpm run lint --if-present

# Direct script aliases
linkpm test
linkpm start

# Run an executable installed in local node_modules/.bin context
linkpm exec tsc --noEmit
linkpm exec prettier --write .

# Download and execute a remote package without persistent install
linkpm dlx cowsay "Hello from LinkPM!"
linkpm dlx degit user/repo my-app
```

---

### 6. Managing Central Global Store & Garbage Collection

```bash
# View central store location, unique packages, versions, and total disk size
linkpm store status

# List all stored packages and versions
linkpm store list

# Show active store directory path
linkpm store path

# Garbage collect unreferenced packages (with 30-day retention grace period)
linkpm store gc

# Dry-run garbage collection to preview what would be pruned
linkpm store gc --dry-run

# Run garbage collection with custom retention period (e.g. 7 days)
linkpm store gc --days 7

# Immediately prune all unreferenced packages bypassing the grace period
linkpm store gc --force
linkpm store gc --all

# Re-check and verify store integrity against tampering or bitrot
linkpm store verify

# Verify store and automatically repair corrupted packages from verified tarballs
linkpm store verify --fix

# Completely purge central store
linkpm store clear
```

---

### 7. Stack Presets & Project Scaffolding

```bash
# Scaffold a full starter project with live UI and instant linked dependencies:
linkpm create frontend my-react-app
linkpm create backend my-api
linkpm create fastify my-fastify-api

# Apply a built-in preset stack to an existing project:
linkpm use frontend
linkpm use backend
linkpm use fastify
linkpm use ui

# Save your own custom team stack:
linkpm preset save my-team-stack react react-dom -d vite,tailwindcss,typescript --desc "Team standard stack"

# Apply custom preset in any project:
linkpm add @my-team-stack

# List available presets:
linkpm preset list
```

---

### 8. Diagnostics, IDE Setup & Auditing

```bash
# Validate Node.js version, NTFS junction capability, store health, and IDE LSP setup
linkpm doctor
linkpm doctor --fix   # Automatically repairs and configures IDE settings (.vscode/settings.json, tsconfig.json)

# Optimize VS Code, Cursor, and WebStorm TypeScript Language Server (LSP) for zero-copy junctions
linkpm ide-init

# Print Unicode ASCII dependency graph
linkpm tree

# Trace exact dependency paths explaining why a package is present
linkpm why lodash

# Check which installed packages have newer versions available
linkpm outdated

# Run a real vulnerability scan (npm bulk advisory API, OSV fallback) across the
# pinned lockfile (text, JSON, or SARIF for GitHub Code Scanning)
linkpm audit
linkpm audit --format sarif -o audit.sarif
```

---

### 9. AI Capability Discovery & Agent Tooling (MCP & Skills)

LinkPM provides optional, security-hardened management for **Model Context Protocol (MCP)** servers and **Agent Skills** directly within the package lifecycle:

```bash
# 1. Install an AI package with explicit capability opt-in:
linkpm add notebooklm-mcp --ai
linkpm add @modelcontextprotocol/server-postgres --ai

# Dedicated AI add command alias:
linkpm ai add notebooklm-mcp

# 2. Inspect all active AI capabilities in the project:
linkpm ai list

# 3. Scan existing node_modules/ for AI capabilities and re-synchronize IDE configs:
linkpm ai sync

# 4. Remove an AI capability and clean up IDE configurations and skill junctions:
linkpm ai remove notebooklm-mcp
```

#### 🛡️ AI Security Model & Safeguards
Running MCP servers allows AI IDEs to execute local processes with user privileges. LinkPM implements strict guardrails:
- **Strictly Opt-In (Default-Off)**: Standard package installs (`linkpm install`, `linkpm ci`, `linkpm add foo`) **never** touch `.cursor/mcp.json`, `mcp_config.json`, or `.agents/skills/`. Only commands explicitly passing `--ai` or `linkpm ai add` will initiate capability discovery.
- **Zero Transitive Wiring**: Only top-level packages explicitly specified by the developer are evaluated. Transitive dependencies are never registered.
- **Interactive Verification**: Before modifying any IDE configuration, LinkPM displays a security notice, target config paths, and the exact command to be registered, requesting explicit user confirmation (`[y/N]`). In automated CI pipelines, registration is safely skipped unless `--yes` (`-y`) is supplied.
- **Cryptographic Command Pinning**: Approved commands and arguments are hashed (SHA-256) and pinned in `.linkpm/ai.json`. If a future package update or dependency modifies the entry point, the hash mismatch flags the capability for re-approval.
- **Secret Sanitization**: Ambient shell environment variables and secrets are never copied into project configuration files; safe placeholder strings are used instead.

---

## 🏗️ Technical Architecture

```
                          [ npm Registry ]
                                 │
                    (downloads tarball once only)
                    (streaming SHA-512 integrity check)
                                 │
                 ┌───────────────────────────────┐
                 │   Central Global Store        │
                 │   ~/.linkpm/store/            │
                 │   ├── express/4.19.2/         │
                 │   ├── lodash/4.17.21/         │
                 │   └── date-fns/2.30.0_patch_*/│
                 └───────────────────────────────┘
                                 │
         • Pure package files (No internal node_modules/)
         • Read-only permissions (chmod 0o444 / NTFS read-only)
         • 30-day retention grace period for unmounted drives
                                 │
            Directory Junctions / Symlinks (Zero-Copy)
                                 │
           ┌─────────────────────┴─────────────────────┐
           ▼                                           ▼
 [ Project A: node_modules/ ]                [ Project B: node_modules/ ]
 ├── .bin/ (binary shims)                    ├── .bin/ (binary shims)
 ├── .linkpm/ (Virtual Store)                ├── .linkpm/ (Virtual Store)
 │   └── pkg-a@1.0.0/node_modules/           │   └── pkg-a@1.0.0/node_modules/
 │       ├── pkg-a  ──► (points to store)    │       ├── pkg-a  ──► (points to store)
 │       └── lodash ──► (points to store v4) │       └── lodash ──► (points to store v3)
 └── pkg-a ──► .linkpm/pkg-a@1.0.0/...       └── pkg-a ──► .linkpm/pkg-a@1.0.0/...
```

### Security & Integrity Highlights

- **Default-Deny Lifecycle Scripts**: Package `install` and `postinstall` scripts are blocked by default. Scripts only run if allow-listed in `onlyBuiltDependencies` or approved via `linkpm approve-builds`.
- **Release-Age Cooldown (`minimumReleaseAge`)**: Enforced during every install. Defaults to a 24-hour waiting window (`86400`s) for newly published package versions to protect against day-zero account takeovers. Urgent hotfixes can bypass via `--ignore-release-age`; dist-tags and ranges resolve to the newest *cooldown-safe* version automatically.
- **Exotic Transitive Dependency Blocking**: Enforced during every install. Transitive dependencies requiring raw git URLs, tarballs, or local paths are blocked by default. Bypass per-run with `--allow-exotic-transitive`. (Resolution of direct `git:` dependencies pins the exact commit SHA in the dependency graph; fetching git repos during install is not yet supported.)
- **Real Vulnerability Auditing**: `linkpm audit` queries the official npm bulk advisory API for every pinned package@version in the lockfile (falling back to OSV.dev), matching installed versions against each advisory's vulnerable range — never a canned list.
- **Private Registry & Auth Support**: The full install path honors `.npmrc`: custom registries, per-scope registries, mirrors, `_authToken` credentials, and auth header stripping on cross-host redirects.
- **Store Integrity Re-Check (`linkpm store verify [--fix]`)**: Verifies stored files against stored SHA-512 hashes and automatically recovers corrupted packages from registry tarballs.
- **Scoped Native Module Build Isolation**: Packages requiring native C/C++ builds are keyed by Node ABI, OS platform, and CPU architecture (`_abi<modules>_<platform>_<arch>`), preventing multi-Node version collisions.
- **Cross-Process Concurrency Locks**: Atomic PID and timestamp-backed file locking (`FileLock`) prevents race conditions between parallel LinkPM processes.
- **Zip-Slip Protection**: Tarball extraction explicitly validates archive paths to block directory traversal attacks (`../../`).
- **Streaming SHA-512 Integrity**: Downloaded tarball buffers are verified against registry checksum manifests before extraction.
- **In-Place Store Poisoning Defense**: Extracted package payloads are marked read-only, preventing edits in `node_modules` from altering shared global packages.
- **Strict CI Lockfile Mode (`--frozen-lockfile`)**: Verifies that every dependency and resolved version in `linkpm-lock.json` matches `package.json` specifications with zero drift.

---

## 🧭 Tooling Compatibility (Running Outside `linkpm run`)

Because packages link to the central store and virtual store topology without redundant copies, running development tools directly outside of `linkpm run` or generated `.bin` shims requires symlink awareness:

| Tool / Runtime | Direct Invocation Command | Recommended Project Configuration |
| :--- | :--- | :--- |
| **Node.js (CJS & ESM)** | `node --preserve-symlinks --preserve-symlinks-main index.js` | Set `NODE_OPTIONS="--preserve-symlinks --preserve-symlinks-main"` in your environment or launch scripts. |
| **TypeScript (`tsc`)** | `tsc --noEmit` | Set `"preserveSymlinks": true` or `"moduleResolution": "bundler"` (or `"node16"`/`"nodenext"`) in `tsconfig.json`. |
| **Vite** | `vite dev` | In `vite.config.ts`: `export default defineConfig({ resolve: { preserveSymlinks: true } })`. |
| **ESLint** | `eslint .` | Resolves standard plugins via project `node_modules/`. For flat config (`eslint.config.js`), no special flags needed. |
| **Jest / Vitest** | `jest` / `vitest` | Vitest respects `resolve.preserveSymlinks` from `vite.config.ts`. In Jest, configure `moduleDirectories: ['node_modules']`. |
| **Webpack** | `webpack --mode development` | In `webpack.config.js`: `resolve: { symlinks: false }`. |

---

## ⚠️ Roadmap & Planned Enhancements

- **File-Level Deduplication**: Store deduplication currently operates at the version directory boundary. Content-addressable storage (CAS) with hardlink deduplication across disparate patch versions is under active development.
- **Git Dependency Installation**: `git:` specs are pinned to exact commit SHAs during resolution; direct repository fetching during install is planned.
- **CLI Shell Autocompletion**: Tab autocompletion for Bash, Zsh, and Fish.

---

## 📄 License

MIT © Dawit Yetmgeta
