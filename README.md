# ⚡ linkpm

> **Next-generation, production-grade JavaScript & TypeScript package manager with global zero-copy store, deterministic DAG resolution, stack presets, and monorepo workspace orchestration.**

[![npm version](https://img.shields.io/npm/v/linkpm.svg)](https://www.npmjs.com/package/linkpm)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)

---

## 🚀 Why LinkPM?

Traditional package managers force painful trade-offs: `npm` duplicates hundreds of megabytes of `node_modules` in every directory, `pnpm` can suffer from complex symlink resolution quirks, and setting up stacks repeatedly wastes developer time.

`linkpm` delivers the best of all worlds:
- **Global Zero-Copy Store**: Every package version is downloaded and verified **exactly once** in `~/.linkpm/store`. Subsequent installations in any project link in **sub-second time (5–25ms)**.
- **Windows-First & Cross-Platform**: Uses native Windows NTFS Directory Junctions without requiring Administrator privileges, and standard symlinks on macOS and Linux.
- **Deterministic DAG Engine**: Independent dependency resolver with topological cycle detection, peer dependency conflict engine, and strict SHA-512 integrity checks.
- **Transactional Rollback**: Atomic directory linking guarantees `node_modules` is never left corrupted or half-installed if an operation fails.
- **Monorepos & Workspaces**: Full support for `pnpm-workspace.yaml` and `package.json` workspaces, `workspace:*` inter-package links, and topological multi-package script runs.
- **One-Command Presets**: Eliminate repetitive dependency typing with curated presets (`frontend`, `backend`, `fastify`, `ui`) and custom user-saved bundles.

---

## 📊 Feature Comparison Matrix

| Feature | `npm` | `pnpm` | `yarn (v1)` | `bun` | `linkpm` |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Global Content Store** | ❌ | ✅ | ❌ | ✅ | ✅ |
| **Zero-Copy Disk Linking** | ❌ | ✅ | ❌ | ✅ | ✅ |
| **Windows NTFS Junctions (No Admin)** | ❌ | ⚠️ | ❌ | ⚠️ | ✅ **Native** |
| **Transactional Rollback** | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Built-in Stack Presets** | ❌ | ❌ | ❌ | ❌ | ✅ |
| **One-Command Scaffolding** | ❌ | ❌ | ❌ | ❌ | ✅ |
| **Monorepo Workspaces (`workspace:*`)** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Topological Multi-Package Runner** | ❌ | ✅ | ⚠️ | ⚠️ | ✅ |
| **On-the-Fly Execution (`dlx`)** | `npx` | `pnpm dlx` | ❌ | `bunx` | `linkpm dlx` |
| **Store Garbage Collection (`gc`)** | ❌ | ✅ | ❌ | ❌ | ✅ |
| **Dependency Tree & Trace (`why`)** | ⚠️ | ✅ | ✅ | ❌ | ✅ |
| **Self-Healing Environment Doctor** | ❌ | ❌ | ❌ | ❌ | ✅ |

---

## 📦 Installation

```bash
npm install -g linkpm
```

Verify your installation:
```bash
linkpm doctor
```

---

## 🛠️ Complete CLI Command Reference

### 1. Installation & Package Management

```bash
# Install all dependencies from package.json
linkpm install
linkpm i

# Add dependencies
linkpm add express cors dotenv

# Add devDependencies
linkpm add -D typescript @types/node tsx

# Fast offline-first installs (using local central store)
linkpm add react --prefer-offline
linkpm add react --offline

# Clean CI install from linkpm-lock.json
linkpm ci

# Remove dependencies and clean node_modules links
linkpm remove lodash axios
linkpm rm express

# Update dependencies against registry
linkpm update
linkpm update express vite
```

### 2. Monorepos & Workspaces

LinkPM natively recognizes `pnpm-workspace.yaml` and `package.json` `"workspaces"`:

```bash
# List all workspace packages in the monorepo
linkpm workspace list
linkpm w list

# Link inter-workspace dependencies (e.g., workspace:*) directly
linkpm workspace link

# Run a script across all workspace packages in topological order
linkpm run -r build
linkpm run --recursive test

# Filter execution to specific packages
linkpm run --filter @my-org/web-app build
linkpm run --filter "*ui*" build
```

### 3. Lifecycle Scripts & Binary Execution

```bash
# Run any package.json script (with pre/post lifecycle hooks and .bin PATH injection)
linkpm run build
linkpm run test -- --watch
linkpm run lint --if-present

# Direct script aliases
linkpm test
linkpm start

# Run a binary installed in local node_modules/.bin context
linkpm exec tsc --noEmit
linkpm exec prettier --write .

# Download and execute a remote package without installing (like npx / dlx)
linkpm dlx cowsay "Hello from LinkPM!"
linkpm dlx degit user/repo my-app
```

### 4. Diagnostics, Security & Dependency Insights

```bash
# Validate Node.js version, NTFS junction capability, and store health
linkpm doctor

# Print Unicode ASCII dependency graph
linkpm tree

# Trace exact dependency paths explaining why a package is present
linkpm why lodash

# Check which installed packages have newer versions available
linkpm outdated

# Run vulnerability scan across installed dependencies
linkpm audit
```

### 5. Managing Central Global Store

```bash
# View central store location, unique packages, versions, and total disk size
linkpm store status

# List all stored packages and versions
linkpm store list

# Show store directory path
linkpm store path

# Garbage collect unreferenced packages from store (freeing disk space)
linkpm store gc
linkpm store gc --dry-run

# Completely purge central store
linkpm store clear
```

### 6. Stack Presets & Project Scaffolding

```bash
# Scaffold a full starter project with live UI and instant linked dependencies:
linkpm create frontend my-react-app
linkpm create backend my-api
linkpm create fastify my-fastify-api

# Apply a preset stack to an existing project:
linkpm use frontend
linkpm use backend
linkpm use fastify
linkpm use ui

# Save your own custom team stack:
linkpm preset save my-team-stack react react-dom -d vite,tailwindcss,typescript --desc "My team standard stack"

# Apply custom preset in any project:
linkpm add @my-team-stack

# List available presets:
linkpm preset list
```

---

## 🏗️ Architecture & Security

```
                          [ npm Registry ]
                                 │
                   (downloads tarball once only)
                   (streaming SHA-512 integrity check)
                                 │
                   ┌─────────────────────────────┐
                   │   Central Global Store      │
                   │   ~/.linkpm/store/          │
                   │   ├── express@4.19.2/       │
                   │   ├── react@19.0.0/         │
                   │   └── zod@3.23.8/           │
                   └─────────────────────────────┘
                                 │
         Cross-Process File Lock + Atomic Extraction
         Zip-Slip Path Traversal Protection
                                 │
            Windows Directory Junctions / Unix Symlinks (5–20ms)
                                 │
         ┌───────────────────────┴───────────────────────┐
         ▼                                               ▼
   [ Project 1: Backend ]                      [ Project 2: Frontend ]
   node_modules/                               node_modules/
   ├── express ──► (points to store)           ├── react ──► (points to store)
   ├── zod     ──► (points to store)           ├── .bin/ ──► (executable shims)
   └── .bin/   ──► (executable shims)          └── ...
```

- **Cross-Process Concurrency Locks**: Uses PID and timestamp-backed file locking (`FileLock`) to prevent race conditions during simultaneous downloads or extractions.
- **Zip-Slip Protection**: Tarball extraction explicitly validates archive paths to block directory traversal attacks (`../../`).
- **Integrity Validation**: Streaming SHA-512 checksum comparison guarantees uncorrupted and untampered package downloads.
- **Deterministic Lockfile v2**: Lockfiles are serialized with sorted package keys and verified for CI build parity.

---

## 📄 License

MIT © Dave
