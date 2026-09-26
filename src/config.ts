import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export interface Preset {
  name: string;
  description?: string;
  dependencies: string[];
  devDependencies: string[];
}

export const LINKPM_HOME = path.join(os.homedir(), '.linkpm');
export const STORE_DIR = path.join(LINKPM_HOME, 'store');
export const TARBALLS_DIR = path.join(LINKPM_HOME, 'tarballs');
export const PRESETS_FILE = path.join(LINKPM_HOME, 'presets.json');

export function safePackageName(name: string): string {
  return name.replace('/', '__');
}

export const BUILTIN_PRESETS: Record<string, Preset> = {
  backend: {
    name: 'backend',
    description: 'Standard Express + TypeScript API stack',
    dependencies: ['express@latest', 'cors@latest', 'dotenv@latest', 'zod@latest'],
    devDependencies: ['typescript@latest', '@types/node@latest', '@types/express@latest', '@types/cors@latest', 'tsx@latest']
  },
  'frontend-react': {
    name: 'frontend-react',
    description: 'Vite + React + Tailwind UI stack',
    dependencies: ['react@latest', 'react-dom@latest', 'lucide-react@latest', 'clsx@latest', 'tailwind-merge@latest'],
    devDependencies: ['vite@latest', '@vitejs/plugin-react@latest', 'typescript@latest', '@types/react@latest', '@types/react-dom@latest', 'tailwindcss@latest', 'postcss@latest', 'autoprefixer@latest']
  },
  frontend: {
    name: 'frontend',
    description: 'Alias for frontend-react',
    dependencies: ['react@latest', 'react-dom@latest', 'lucide-react@latest', 'clsx@latest', 'tailwind-merge@latest'],
    devDependencies: ['vite@latest', '@vitejs/plugin-react@latest', 'typescript@latest', '@types/react@latest', '@types/react-dom@latest', 'tailwindcss@latest', 'postcss@latest', 'autoprefixer@latest']
  },
  ui: {
    name: 'ui',
    description: 'Tailwind + Icons UI pack',
    dependencies: ['lucide-react@latest', 'clsx@latest', 'tailwind-merge@latest'],
    devDependencies: ['tailwindcss@latest', 'postcss@latest', 'autoprefixer@latest']
  },
  fastify: {
    name: 'fastify',
    description: 'High performance Fastify + TypeScript API stack',
    dependencies: ['fastify@latest', '@fastify/cors@latest', 'dotenv@latest', 'zod@latest'],
    devDependencies: ['typescript@latest', '@types/node@latest', 'tsx@latest']
  }
};

export function ensureDirectories() {
  if (!fs.existsSync(LINKPM_HOME)) fs.mkdirSync(LINKPM_HOME, { recursive: true });
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
  if (!fs.existsSync(TARBALLS_DIR)) fs.mkdirSync(TARBALLS_DIR, { recursive: true });
}

export function loadUserPresets(): Record<string, Preset> {
  ensureDirectories();
  if (!fs.existsSync(PRESETS_FILE)) {
    saveUserPresets({});
    return {};
  }
  try {
    const raw = fs.readFileSync(PRESETS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function saveUserPresets(presets: Record<string, Preset>): void {
  ensureDirectories();
  fs.writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 2), 'utf-8');
}

export function getAllPresets(): Record<string, Preset> {
  const user = loadUserPresets();
  return { ...BUILTIN_PRESETS, ...user };
}
