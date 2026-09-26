# ⚡ linkpm

> **Lightning-fast NPM package manager with a central store, directory links, and stack presets.**

`linkpm` solves the two biggest frustrations with standard `npm`:
1. **Speed & Disk Space**: Instead of downloading and duplicating gigabytes of `node_modules` across every project, `linkpm` caches packages **once** in a central store (`~/.linkpm/store`) and creates instant Windows Directory Junctions (or Unix symlinks) into your project in milliseconds.
2. **Repetitive Typing**: Instead of typing the same 10-15 packages for every backend or frontend project, `linkpm` provides one-command **Presets** (`linkpm use frontend`, `linkpm use backend`) and lets you save your own custom bundles.

---

## 📦 Installation

Install globally from npm:

```bash
npm install -g linkpm
```

Or run via npx:
```bash
npx linkpm --help
```

---

## 🚀 Quick Start

### 1. Create a Complete Project in Seconds (Scaffolding + Instant Link)
Instantly generate a full starter project with boilerplate code and all dependencies linked from your central cache:

```bash
# ⚛️ Create a React + Vite + Tailwind frontend app with live UI:
linkpm create frontend my-react-app

# 🛠️ Create an Express + TypeScript API:
linkpm create backend my-api

# ⚡ Create a Fastify + TypeScript API:
linkpm create fastify my-fastify-api
```

Then simply `cd <project>` and `npm run dev`!

---

## 🛠️ Usage

### 1. Adding & Removing Packages
Add individual packages:
```bash
linkpm add express cors dotenv
```
Save as `devDependencies` with `-D`:
```bash
linkpm add -D typescript @types/node tsx
```

Remove packages cleanly:
```bash
linkpm remove lodash axios
# or
linkpm rm express
```

### 2. Smart Offline-First Mode
Install packages in **5-20 milliseconds** without touching the internet if they are in your central store:
```bash
linkpm add react --offline
# or prefer cached if available:
linkpm add express --prefer-offline
```

### 3. Deterministic Lockfile & CI (`linkpm ci`)
Every install automatically generates and updates `linkpm-lock.json` with SHA-512 checksums for secure, reproducible builds.

In CI/CD environments or team deployments, run clean lockfile installs:
```bash
linkpm ci
```

### 4. Updating Packages
Refresh packages against the registry:
```bash
linkpm update
# or update specific packages:
linkpm update express vite
```

### 5. Using Stack Presets (Instant Frontend & Backend Setup)
Install complete, pre-configured stacks in a single command using `linkpm use`:

```bash
# Vite + React + Tailwind frontend stack
linkpm use frontend

# Standard Express + TypeScript backend stack
linkpm use backend

# Fastify + TypeScript backend stack
linkpm use fastify

# Tailwind + UI Icons pack
linkpm use ui
```

*(You can also use `linkpm add -P <preset>` or `linkpm add "@frontend"`)*

### 6. Creating Your Own Custom Presets
Save your favorite library combinations once, use them everywhere:

```bash
# Save a custom preset with dependencies and devDependencies:
linkpm preset save my-stack react react-dom lucide-react -d vite,tailwindcss,typescript --desc "My primary React stack"

# Then in any project:
linkpm add @my-stack
```

List all available presets:
```bash
linkpm preset list
```

Remove a custom preset:
```bash
linkpm preset remove my-stack
```

### 7. Installing All Dependencies
Just like `npm install`, links all dependencies declared in `package.json`:
```bash
linkpm install
# or
linkpm i
```

### 8. Managing the Central Store
Check stored packages and disk space saved:
```bash
linkpm store list
```

Clear the central store:
```bash
linkpm store clear
```

---

## 🏗️ Architecture

```
                          [ npm Registry ]
                                 │
                   (downloads tarball once only)
                                 ▼
                   ┌─────────────────────────────┐
                   │  Central Global Store       │
                   │  ~/.linkpm/store/           │
                   │  ├── express@4.19.2/        │
                   │  ├── react@19.0.0/          │
                   │  └── zod@3.23.8/            │
                   └──────────────┬──────────────┘
                                 │
            Windows Directory Junctions / Unix Symlinks (0.001s)
                ┌─────────────────┴─────────────────┐
                ▼                                   ▼
     [ Project 1: Backend ]              [ Project 2: Frontend ]
     node_modules/                       node_modules/
     ├── express ──► (points to store)   ├── react ──► (points to store)
     └── zod     ──► (points to store)   └── .bin/ ──► (executable shims)
```

- **Windows Directory Junctions**: Requires no Administrator privileges and works on any NTFS drive.
- **Node Resolution & `.bin`**: Automatically generates `.cmd`, `.ps1`, and Unix shell executable shims inside `node_modules/.bin/` with `NODE_PATH` and `--preserve-symlinks` configured so all scripts (`npm run dev`, `npx`, etc.) run out of the box.
- **Transitive Resolution**: Automatically resolves and isolates sub-dependencies per package in the central store.

---

## 📜 License
MIT
