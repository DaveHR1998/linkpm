import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { installPreset } from './installer.js';

export interface ScaffoldOptions {
  template: 'frontend' | 'backend' | 'fastify';
  projectName: string;
  targetDir: string;
}

export async function scaffoldProject(templateInput: string, projectNameInput?: string): Promise<void> {
  const template = templateInput.toLowerCase();
  const projectName = projectNameInput || (template === 'frontend' ? 'my-frontend' : 'my-backend');
  const targetDir = path.resolve(process.cwd(), projectName);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  console.log(`\n${pc.bold(pc.blue('⚡ linkpm scaffold:'))} Creating ${pc.bold(pc.cyan(template))} project in ${pc.green(targetDir)}\n`);

  if (template === 'frontend' || template === 'react' || template === 'vite') {
    await scaffoldFrontend(targetDir, projectName);
  } else if (template === 'backend' || template === 'express' || template === 'api') {
    await scaffoldBackend(targetDir, projectName);
  } else if (template === 'fastify') {
    await scaffoldFastify(targetDir, projectName);
  } else {
    throw new Error(`Unknown template "${templateInput}". Available templates: frontend, backend, fastify.`);
  }

  console.log(pc.bold(pc.green('\n🎉 Project scaffolded and dependencies linked successfully!')));
  console.log(pc.bold('\nTo start developing:'));
  console.log(pc.cyan(`  cd ${projectName}`));
  console.log(pc.cyan(`  npm run dev\n`));
}

import { fileURLToPath } from 'node:url';

function copyFrontendAssets(targetDir: string): void {
  const publicDir = path.join(targetDir, 'public');
  const assetsDir = path.join(targetDir, 'src', 'assets');
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
  if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

  let thisDir = '';
  try {
    thisDir = path.dirname(fileURLToPath(import.meta.url));
  } catch {}

  const candidates = [
    path.resolve(thisDir, '../linkpm.png'),
    path.resolve(thisDir, '../../linkpm.png'),
    path.resolve(thisDir, 'linkpm.png'),
    path.resolve(process.cwd(), 'linkpm.png')
  ];

  for (const src of candidates) {
    if (src && fs.existsSync(src)) {
      try {
        fs.copyFileSync(src, path.join(publicDir, 'linkpm.png'));
        fs.copyFileSync(src, path.join(assetsDir, 'linkpm.png'));
        break;
      } catch {}
    }
  }

  const reactSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-11.5 -10.23174 23 20.46348">
  <circle cx="0" cy="0" r="2.05" fill="#61dafb"/>
  <g stroke="#61dafb" stroke-width="1" fill="none">
    <ellipse rx="11" ry="4.2"/>
    <ellipse rx="11" ry="4.2" transform="rotate(60)"/>
    <ellipse rx="11" ry="4.2" transform="rotate(120)"/>
  </g>
</svg>`;
  fs.writeFileSync(path.join(publicDir, 'react.svg'), reactSvg, 'utf-8');
  fs.writeFileSync(path.join(assetsDir, 'react.svg'), reactSvg, 'utf-8');
}

async function scaffoldFrontend(targetDir: string, projectName: string): Promise<void> {
  // 1. package.json
  const pkgJson = {
    name: projectName,
    version: '0.1.0',
    type: 'module',
    scripts: {
      dev: 'vite',
      build: 'tsc && vite build',
      preview: 'vite preview'
    }
  };
  fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n', 'utf-8');

  // 2. vite.config.ts
  const viteConfig = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    preserveSymlinks: true
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-dom/client']
  },
  server: {
    port: 3000,
    open: true
  }
});
`;
  fs.writeFileSync(path.join(targetDir, 'vite.config.ts'), viteConfig, 'utf-8');

  // 3. tsconfig.json
  const tsConfig = `{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
`;
  fs.writeFileSync(path.join(targetDir, 'tsconfig.json'), tsConfig, 'utf-8');

  // 4. Copy logos (linkpm.png and react.svg)
  copyFrontendAssets(targetDir);

  // 5. index.html
  const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/png" href="/linkpm.png" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${projectName} · linkpm + React</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
  fs.writeFileSync(path.join(targetDir, 'index.html'), indexHtml, 'utf-8');

  // 6. src directory
  const srcDir = path.join(targetDir, 'src');
  if (!fs.existsSync(srcDir)) fs.mkdirSync(srcDir, { recursive: true });

  // 7. src/index.css (Dark page with green accent & Vite-style aesthetics)
  const indexCss = `:root {
  font-family: Inter, system-ui, Avenir, Helvetica, Arial, sans-serif;
  line-height: 1.5;
  font-weight: 400;

  color-scheme: dark;
  color: rgba(255, 255, 255, 0.87);
  background-color: #121413;

  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

a {
  font-weight: 500;
  color: #22c55e;
  text-decoration: inherit;
  transition: color 0.2s ease;
}
a:hover {
  color: #4ade80;
}

body {
  margin: 0;
  display: flex;
  place-items: center;
  min-width: 320px;
  min-height: 100vh;
  background-color: #121413;
}

#root {
  max-width: 1280px;
  margin: 0 auto;
  padding: 2rem;
  text-align: center;
}

.logo {
  height: 6em;
  padding: 1.5em;
  will-change: filter;
  transition: filter 300ms, transform 200ms ease;
  cursor: pointer;
}
.logo:hover {
  filter: drop-shadow(0 0 2em #22c55e);
  transform: scale(1.05);
}
.logo.react:hover {
  filter: drop-shadow(0 0 2em #61dafbaa);
}

@keyframes logo-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: no-preference) {
  a:nth-of-type(2) .logo {
    animation: logo-spin infinite 20s linear;
  }
}

h1 {
  font-size: 3.2em;
  line-height: 1.1;
  font-weight: 700;
  color: #f1f5f9;
  margin: 0.67em 0;
}

.card {
  padding: 2em;
}

.card p {
  color: #94a3b8;
  margin-top: 1rem;
}

.card code {
  background-color: #1a221d;
  color: #4ade80;
  padding: 0.2em 0.4em;
  border-radius: 4px;
  font-size: 0.9em;
}

button {
  border-radius: 8px;
  border: 1px solid #27332b;
  padding: 0.6em 1.2em;
  font-size: 1em;
  font-weight: 500;
  font-family: inherit;
  background-color: #18201a;
  color: #f1f5f9;
  cursor: pointer;
  transition: border-color 0.25s, background-color 0.25s, box-shadow 0.25s;
}
button:hover {
  border-color: #22c55e;
  background-color: #1e2921;
  box-shadow: 0 0 16px rgba(34, 197, 94, 0.3);
}
button:focus,
button:focus-visible {
  outline: 4px auto -webkit-focus-ring-color;
}

.read-the-docs {
  color: #64748b;
  font-size: 0.9em;
  margin-top: 2rem;
}
`;
  fs.writeFileSync(path.join(srcDir, 'index.css'), indexCss, 'utf-8');

  // 8. src/main.tsx
  const mainTsx = `import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`;
  fs.writeFileSync(path.join(srcDir, 'main.tsx'), mainTsx, 'utf-8');

  // 9. src/App.tsx
  const appTsx = `import { useState } from 'react';
import './index.css';

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <>
      <div>
        <a href="https://github.com/davehr/linkpm" target="_blank" rel="noreferrer">
          <img src="/linkpm.png" className="logo" alt="linkpm logo" />
        </a>
        <a href="https://react.dev" target="_blank" rel="noreferrer">
          <img src="/react.svg" className="logo react" alt="React logo" />
        </a>
      </div>
      <h1>linkpm + React</h1>
      <div className="card">
        <button onClick={() => setCount((c) => c + 1)}>
          count is {count}
        </button>
        <p>
          Edit <code>src/App.tsx</code> and save to test HMR
        </p>
      </div>
      <p className="read-the-docs">
        Click on the linkpm and React logos to learn more
      </p>
    </>
  );
}
`;
  fs.writeFileSync(path.join(srcDir, 'App.tsx'), appTsx, 'utf-8');

  // 10. Install preset dependencies directly into targetDir
  await installPreset('frontend', targetDir);
}

async function scaffoldBackend(targetDir: string, projectName: string): Promise<void> {
  // 1. package.json
  const pkgJson = {
    name: projectName,
    version: '0.1.0',
    type: 'module',
    scripts: {
      dev: 'tsx watch src/server.ts',
      build: 'tsc',
      start: 'node dist/server.js'
    }
  };
  fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n', 'utf-8');

  // 2. tsconfig.json
  const tsConfig = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
`;
  fs.writeFileSync(path.join(targetDir, 'tsconfig.json'), tsConfig, 'utf-8');

  // 3. .env
  fs.writeFileSync(path.join(targetDir, '.env'), 'PORT=4000\nNODE_ENV=development\n', 'utf-8');

  // 4. src directory
  const srcDir = path.join(targetDir, 'src');
  if (!fs.existsSync(srcDir)) fs.mkdirSync(srcDir, { recursive: true });

  // 5. src/server.ts
  const serverTs = `import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Sample API route
const UserSchema = z.object({
  name: z.string().min(2),
  email: z.string().email()
});

app.post('/api/users', (req: Request, res: Response) => {
  const result = UserSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error.format() });
  }

  return res.status(201).json({
    message: 'User created successfully',
    user: result.data
  });
});

app.listen(PORT, () => {
  console.log(\`⚡ Server running on http://localhost:\${PORT}\`);
  console.log(\`   Health check: http://localhost:\${PORT}/health\`);
});
`;
  fs.writeFileSync(path.join(srcDir, 'server.ts'), serverTs, 'utf-8');

  // 6. Install backend preset
  await installPreset('backend', targetDir);
}

async function scaffoldFastify(targetDir: string, projectName: string): Promise<void> {
  const pkgJson = {
    name: projectName,
    version: '0.1.0',
    type: 'module',
    scripts: {
      dev: 'tsx watch src/server.ts',
      build: 'tsc',
      start: 'node dist/server.js'
    }
  };
  fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n', 'utf-8');

  const tsConfig = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
`;
  fs.writeFileSync(path.join(targetDir, 'tsconfig.json'), tsConfig, 'utf-8');
  fs.writeFileSync(path.join(targetDir, '.env'), 'PORT=4000\nNODE_ENV=development\n', 'utf-8');

  const srcDir = path.join(targetDir, 'src');
  if (!fs.existsSync(srcDir)) fs.mkdirSync(srcDir, { recursive: true });

  const serverTs = `import Fastify from 'fastify';
import cors from '@fastify/cors';
import dotenv from 'dotenv';

dotenv.config();

const fastify = Fastify({ logger: true });

await fastify.register(cors);

fastify.get('/health', async () => {
  return { status: 'ok', time: new Date() };
});

const PORT = Number(process.env.PORT) || 4000;

try {
  await fastify.listen({ port: PORT, host: '0.0.0.0' });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
`;
  fs.writeFileSync(path.join(srcDir, 'server.ts'), serverTs, 'utf-8');

  await installPreset('fastify', targetDir);
}
