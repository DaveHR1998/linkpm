# Contributing to linkpm

Thank you for your interest in contributing to **linkpm**! linkpm is an enterprise-grade, deterministic, content-addressable package manager and AI agent runtime for JavaScript and TypeScript.

This guide outlines how to get started, run tests, build the codebase, and submit pull requests.

---

## 🛠️ Development Setup

### Prerequisites
- **Node.js**: v18.0.0 or higher
- **npm** or **linkpm**: To bootstrap initial dependencies

### 1. Clone the Repository
```bash
git clone https://github.com/DaveHR1998/linkpm.git
cd linkpm
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Build the Project
linkpm uses [tsup](https://tsup.egoist.dev/) for fast TypeScript bundling:
```bash
npm run build
```
To run the bundler in watch mode during development:
```bash
npm run dev
```

---

## 🧪 Testing

We use the native Node.js test runner (`node:test`). Tests cover resolution, linking, security, stores, lockfiles, transactions, and AI capabilities.

### Run All Tests
```bash
npm test
```

### Run a Specific Test Suite
```bash
node --loader ts-node/esm --test tests/security_and_reliability.test.ts
```

All new features and bug fixes must include unit or integration tests verifying their behavior.

---

## 🏗️ Architecture Overview

The codebase is organized under `src/`:

| Directory / Module | Purpose |
| :--- | :--- |
| `src/cli.ts` | Command-line interface definitions and command routing |
| `src/resolver/` | Dependency resolution, semver matching, registry client, security cooldown |
| `src/store/` | Content-addressable global store, hardlink/clone management, lockfiles, integrity |
| `src/linker/` | Virtual store structure, symlink/junction layout, peer context isolation |
| `src/scripts/` | Lifecycle script sandboxing, default-deny approvals (`approve-builds`) |
| `src/patches/` | Zero-dependency patch parsing, line-offset diff application, traversal defense |
| `src/ai/` | MCP server discovery, AI agent skills, tool installation |
| `src/config/` | Configuration resolution (`.npmrc`, package.json settings) |
| `src/utils/` | Custom typed errors, terminal formatting, hashing utilities |

---

## 🤝 Code Style & Commit Conventions

- Use TypeScript with strict type checking enabled.
- Avoid external runtime dependencies where native Node.js APIs suffice (e.g. `node:crypto`, `node:fs`, `node:test`, `node:child_process`).
- Keep commit messages concise and descriptive (e.g. `fix(store): verify corrupted tarball fallback`).

---

## 🎯 Good First Issues for New Contributors

If you are looking for a place to contribute, here are recommended areas:

1. **CLI Autocompletion (`linkpm completion`)**: Generate shell completion scripts for Bash, Zsh, and Fish.
2. **Additional Lockfile Exporters (`linkpm convert`)**: Add bidirectional conversion support for `yarn.lock` (v1 and Berry) and `pnpm-lock.yaml`.
3. **Enhanced Color Formatting in Windows Terminals**: Improve ANSI/Unicode fallback glyphs when running inside standard Windows `cmd.exe` vs Windows Terminal.
4. **Offline Mode Validation**: Expand test coverage for `--offline` resolution to assert zero outbound network requests.
5. **JSON Output for Doctor & Diagnostics**: Add `--json` flag to `linkpm doctor` and `linkpm diagnostics` for programmatic CI integration.
6. **Progress Bar Customization**: Support quiet/minimal progress bars when running in CI environments (`CI=true`).

---

## 🛡️ Security Vulnerabilities

Please do **NOT** open public issues for sensitive security vulnerabilities. Follow the instructions in our [SECURITY.md](SECURITY.md).
