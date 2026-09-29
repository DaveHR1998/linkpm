# Contributing to linkpm

Thank you for your interest in contributing to **linkpm**! linkpm is a deterministic, content-addressable package manager and AI agent runtime for JavaScript and TypeScript.

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

We use the native Node.js test runner via `tsx` (`tsx --test`). Tests cover resolution, linking, security, stores, lockfiles, transactions, and AI capabilities.

### Run All Tests
```bash
npm test
```

### Run a Specific Test Suite
```bash
npx tsx --test tests/security_and_reliability.test.ts
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

If you are looking for a place to contribute, we have prepared detailed specifications and acceptance criteria for 6 starter issues:

1. [**CLI Autocompletion (`linkpm completion`)**](.github/good-first-issues/01-shell-autocompletion.md) ([Open on GitHub](https://github.com/DaveHR1998/linkpm/issues/new?title=feat%28cli%29%3A+shell+autocompletion+for+Bash%2C+Zsh%2C+and+Fish&labels=good+first+issue%2Cenhancement%2Ccli)): Generate shell completion scripts for Bash, Zsh, and Fish.
2. [**Additional Lockfile Exporters (`linkpm convert`)**](.github/good-first-issues/02-lockfile-conversion.md) ([Open on GitHub](https://github.com/DaveHR1998/linkpm/issues/new?title=feat%28lockfile%29%3A+bidirectional+conversion+for+yarn.lock+and+pnpm-lock.yaml&labels=good+first+issue%2Cenhancement%2Clockfile)): Add bidirectional conversion support for `yarn.lock` (v1 and Berry) and `pnpm-lock.yaml`.
3. [**Enhanced Color Formatting in Windows Terminals**](.github/good-first-issues/03-windows-terminal-glyphs.md) ([Open on GitHub](https://github.com/DaveHR1998/linkpm/issues/new?title=fix%28terminal%29%3A+improve+ANSI%2FUnicode+fallback+glyphs+in+standard+Windows+cmd.exe&labels=good+first+issue%2Cbug%2Cwindows)): Improve ANSI/Unicode fallback glyphs when running inside standard Windows `cmd.exe` vs Windows Terminal.
4. [**Offline Mode Validation**](.github/good-first-issues/04-offline-test-suite.md) ([Open on GitHub](https://github.com/DaveHR1998/linkpm/issues/new?title=test%28offline%29%3A+add+zero-network+assertion+test+suite+for+--offline+mode&labels=good+first+issue%2Ctesting%2Creliability)): Expand test coverage for `--offline` resolution to assert zero outbound network requests.
5. [**JSON Output for Doctor & Diagnostics**](.github/good-first-issues/05-diagnostics-json.md) ([Open on GitHub](https://github.com/DaveHR1998/linkpm/issues/new?title=feat%28diagnostics%29%3A+add+--json+flag+to+linkpm+doctor+and+linkpm+diagnostics&labels=good+first+issue%2Cenhancement%2Cdx)): Add `--json` flag to `linkpm doctor` and `linkpm diagnostics` for programmatic CI integration.
6. [**Progress Bar Customization**](.github/good-first-issues/06-ci-quiet-progress.md) ([Open on GitHub](https://github.com/DaveHR1998/linkpm/issues/new?title=feat%28ui%29%3A+support+minimal%2Fquiet+progress+bar+when+CI%3Dtrue&labels=good+first+issue%2Cenhancement%2Cui)): Support quiet/minimal progress bars when running in CI environments (`CI=true`).

---

## 🛡️ Security Vulnerabilities

Please do **NOT** open public issues for sensitive security vulnerabilities. Follow the instructions in our [SECURITY.md](SECURITY.md).
