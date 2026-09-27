import fs from 'node:fs';
import path from 'node:path';
import { LINKPM_HOME, safePackageName } from '../config/index.js';
import { getPackageStoreDir, isPackageInStore } from '../store/index.js';
import { readPackageJson, addPatchedDependency } from '../package-json.js';
import { LinkPMError } from '../utils/errors.js';

export const PATCH_TEMP_DIR = path.join(LINKPM_HOME, 'patching');

export interface PatchMetadata {
  packageName: string;
  version: string;
  originalDir: string;
  projectRoot: string;
}

/**
 * Prepares a package for editing by copying it to a temporary working directory.
 */
export async function preparePatch(packageQuery: string, projectRoot: string): Promise<{ editDir: string; meta: PatchMetadata }> {
  let pkgName = packageQuery.trim();
  let requestedVersion: string | null = null;

  if (pkgName.includes('@') && !pkgName.startsWith('@')) {
    const atIdx = pkgName.indexOf('@');
    requestedVersion = pkgName.slice(atIdx + 1);
    pkgName = pkgName.slice(0, atIdx);
  } else if (pkgName.startsWith('@')) {
    const secondAt = pkgName.indexOf('@', 1);
    if (secondAt !== -1) {
      requestedVersion = pkgName.slice(secondAt + 1);
      pkgName = pkgName.slice(0, secondAt);
    }
  }

  // 1. Locate package either in project's node_modules or store
  let sourceDir = path.join(projectRoot, 'node_modules', pkgName);
  if (!fs.existsSync(sourceDir)) {
    throw new LinkPMError(`Package "${pkgName}" is not installed in ${projectRoot}`, {
      code: 'ERR_PACKAGE_NOT_FOUND',
      packageName: pkgName,
      hint: `Run "linkpm add ${pkgName}" first before creating a patch.`
    });
  }

  // Resolve through junction/symlink if applicable
  try {
    sourceDir = fs.realpathSync(sourceDir);
  } catch {}

  const pkgJsonPath = path.join(sourceDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    throw new LinkPMError(`Invalid package: missing package.json at ${sourceDir}`, {
      code: 'ERR_STORE_CORRUPTION'
    });
  }

  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
  const version = pkgJson.version || '0.0.0';

  if (!fs.existsSync(PATCH_TEMP_DIR)) {
    fs.mkdirSync(PATCH_TEMP_DIR, { recursive: true });
  }

  const safeName = safePackageName(pkgName);
  const editDir = path.join(PATCH_TEMP_DIR, `${safeName}-${version}-${Date.now()}`);

  // Copy all files from sourceDir to editDir (ignoring internal node_modules)
  copyDirectoryRecursive(sourceDir, editDir);

  const meta: PatchMetadata = {
    packageName: pkgName,
    version,
    originalDir: sourceDir,
    projectRoot
  };

  fs.writeFileSync(path.join(editDir, '.linkpm-patch-meta.json'), JSON.stringify(meta, null, 2), 'utf-8');

  return { editDir, meta };
}

/**
 * Commits changes made in editDir, writes a .patch file, updates package.json, and applies it.
 */
export async function commitPatch(editDir: string, projectRootOverride?: string): Promise<{ patchPath: string; patchRelPath: string; packageKey: string }> {
  const metaPath = path.join(editDir, '.linkpm-patch-meta.json');
  if (!fs.existsSync(metaPath)) {
    throw new LinkPMError(`Directory "${editDir}" does not contain .linkpm-patch-meta.json`, {
      code: 'ERR_COMMAND_FAILED',
      hint: 'Ensure you pass the directory created by "linkpm patch <package>".'
    });
  }

  const meta: PatchMetadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  const projectRoot = projectRootOverride || meta.projectRoot;
  const packageKey = `${meta.packageName}@${meta.version}`;

  // Delete meta file from editDir before diffing
  fs.rmSync(metaPath, { force: true });

  const patchContent = createUnifiedDiff(meta.originalDir, editDir);
  if (!patchContent.trim()) {
    throw new LinkPMError(`No changes detected in "${editDir}" compared to original package`, {
      code: 'ERR_COMMAND_FAILED',
      hint: 'Modify at least one file before running linkpm patch-commit.'
    });
  }

  const patchesDir = path.join(projectRoot, 'patches');
  if (!fs.existsSync(patchesDir)) {
    fs.mkdirSync(patchesDir, { recursive: true });
  }

  const safeName = safePackageName(meta.packageName);
  const patchFileName = `${safeName}@${meta.version}.patch`;
  const patchPath = path.join(patchesDir, patchFileName);
  const patchRelPath = `patches/${patchFileName}`;

  fs.writeFileSync(patchPath, patchContent, 'utf-8');

  // Register in package.json
  addPatchedDependency(projectRoot, packageKey, patchRelPath);

  // Apply patch directly to the active package in node_modules or store
  applyPatchToDirectory(meta.originalDir, patchContent);

  // Clean up temporary edit directory
  try {
    fs.rmSync(editDir, { recursive: true, force: true });
  } catch {}

  return {
    patchPath,
    patchRelPath,
    packageKey
  };
}

/**
 * Creates a unified diff between two directories.
 */
export function createUnifiedDiff(originalDir: string, modifiedDir: string): string {
  const diffChunks: string[] = [];
  const originalFiles = listRelativeFiles(originalDir);
  const modifiedFiles = listRelativeFiles(modifiedDir);
  const allFiles = Array.from(new Set([...originalFiles, ...modifiedFiles])).sort();

  for (const relPath of allFiles) {
    if (relPath === 'node_modules' || relPath.startsWith('node_modules/') || relPath.startsWith('node_modules\\')) {
      continue;
    }

    const origPath = path.join(originalDir, relPath);
    const modPath = path.join(modifiedDir, relPath);

    const origExists = fs.existsSync(origPath);
    const modExists = fs.existsSync(modPath);

    const posixRel = relPath.replace(/\\/g, '/');

    if (!origExists && modExists) {
      // New file
      const modContent = fs.readFileSync(modPath, 'utf-8');
      const lines = modContent.split(/\r?\n/);
      diffChunks.push(`diff --git a/${posixRel} b/${posixRel}`);
      diffChunks.push(`new file mode 100644`);
      diffChunks.push(`--- /dev/null`);
      diffChunks.push(`+++ b/${posixRel}`);
      diffChunks.push(`@@ -0,0 +1,${lines.length} @@`);
      for (const line of lines) {
        diffChunks.push(`+${line}`);
      }
    } else if (origExists && !modExists) {
      // Deleted file
      const origContent = fs.readFileSync(origPath, 'utf-8');
      const lines = origContent.split(/\r?\n/);
      diffChunks.push(`diff --git a/${posixRel} b/${posixRel}`);
      diffChunks.push(`deleted file mode 100644`);
      diffChunks.push(`--- a/${posixRel}`);
      diffChunks.push(`+++ /dev/null`);
      diffChunks.push(`@@ -1,${lines.length} +0,0 @@`);
      for (const line of lines) {
        diffChunks.push(`-${line}`);
      }
    } else if (origExists && modExists) {
      // Modified file
      const origContent = fs.readFileSync(origPath, 'utf-8');
      const modContent = fs.readFileSync(modPath, 'utf-8');

      if (origContent !== modContent) {
        const fileDiff = computeLineDiff(origContent, modContent, posixRel);
        if (fileDiff) {
          diffChunks.push(fileDiff);
        }
      }
    }
  }

  return diffChunks.join('\n') + '\n';
}

function computeLineDiff(oldText: string, newText: string, filename: string): string | null {
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);

  const header = [
    `diff --git a/${filename} b/${filename}`,
    `--- a/${filename}`,
    `+++ b/${filename}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`
  ];

  const body: string[] = [];

  // Simple and robust unified diff generation
  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      body.push(` ${oldLines[i]}`);
      i++;
      j++;
    } else if (j < newLines.length && (i >= oldLines.length || !oldLines.slice(i).includes(newLines[j]))) {
      body.push(`+${newLines[j]}`);
      j++;
    } else if (i < oldLines.length) {
      body.push(`-${oldLines[i]}`);
      i++;
    }
  }

  return [...header, ...body].join('\n');
}

/**
 * Applies a unified diff patch to a target directory.
 */
export function applyPatchToDirectory(targetDir: string, patchContent: string): void {
  const lines = patchContent.split(/\r?\n/);
  let currentFile: string | null = null;
  let isNew = false;
  let isDelete = false;
  let hunkLines: string[] = [];

  const flushHunk = () => {
    if (!currentFile) return;
    const dest = path.join(targetDir, currentFile);

    if (isDelete) {
      if (fs.existsSync(dest)) {
        fs.unlinkSync(dest);
      }
      return;
    }

    if (isNew) {
      const parent = path.dirname(dest);
      if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
      const addedLines = hunkLines.filter(l => l.startsWith('+')).map(l => l.slice(1));
      fs.writeFileSync(dest, addedLines.join('\n'), 'utf-8');
      return;
    }

    // Modification
    if (fs.existsSync(dest)) {
      let orig = fs.readFileSync(dest, 'utf-8').split(/\r?\n/);
      let newResult: string[] = [];
      let origIdx = 0;

      for (const line of hunkLines) {
        if (line.startsWith(' ')) {
          newResult.push(orig[origIdx] !== undefined ? orig[origIdx] : line.slice(1));
          origIdx++;
        } else if (line.startsWith('+')) {
          newResult.push(line.slice(1));
        } else if (line.startsWith('-')) {
          origIdx++; // skip line
        }
      }

      // Append any remainder
      while (origIdx < orig.length) {
        newResult.push(orig[origIdx++]);
      }

      fs.writeFileSync(dest, newResult.join('\n'), 'utf-8');
    }
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];

    if (line.startsWith('diff --git')) {
      if (currentFile && hunkLines.length > 0) {
        flushHunk();
      }
      currentFile = null;
      isNew = false;
      isDelete = false;
      hunkLines = [];
    } else if (line.startsWith('new file mode')) {
      isNew = true;
    } else if (line.startsWith('deleted file mode')) {
      isDelete = true;
    } else if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6).trim();
    } else if (line.startsWith('--- a/') && !currentFile) {
      currentFile = line.slice(6).trim();
    } else if (line.startsWith('@@')) {
      // Hunk header
      continue;
    } else if (currentFile && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
      hunkLines.push(line);
    }
  }

  if (currentFile && hunkLines.length > 0) {
    flushHunk();
  }
}

function copyDirectoryRecursive(src: string, dest: string): void {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git')) {
      continue;
    }
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryRecursive(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

function listRelativeFiles(dir: string, baseDir: string = dir): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listRelativeFiles(full, baseDir));
    } else if (entry.isFile()) {
      results.push(path.relative(baseDir, full));
    }
  }
  return results;
}
