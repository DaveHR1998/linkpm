import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LINKPM_HOME, safePackageName } from '../config/index.js';
import { getPackageStoreDir, isPackageInStore } from '../store/index.js';
import { linkPackage } from '../linker.js';
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

  // Calculate isolated patch store directory
  const patchHash = crypto.createHash('sha256').update(patchContent.trim()).digest('hex').slice(0, 8);
  const patchedStoreDir = getPackageStoreDir(meta.packageName, `${meta.version}_patch_${patchHash}`);

  // Create isolated store directory without mutating the original clean package
  if (!fs.existsSync(patchedStoreDir)) {
    fs.mkdirSync(patchedStoreDir, { recursive: true });
    copyDirectoryRecursive(meta.originalDir, patchedStoreDir);
    applyPatchToDirectory(patchedStoreDir, patchContent);
  }

  // Link project's node_modules to the isolated patched store directory
  try {
    linkPackage(projectRoot, meta.packageName, patchedStoreDir);
  } catch {}

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
interface FilePatchHunk {
  origStart: number;
  origCount: number;
  lines: string[];
}

export function applyPatchToDirectory(targetDir: string, patchContent: string): void {
  const lines = patchContent.split(/\r?\n/);
  let currentFile: string | null = null;
  let isNew = false;
  let isDelete = false;
  let currentHunks: FilePatchHunk[] = [];
  let currentHunk: FilePatchHunk | null = null;

  const flushFile = () => {
    if (!currentFile) return;

    // Zip-Slip Path Traversal Protection
    const normalizedFile = path.normalize(currentFile).replace(/^([/\\])+/, '');
    if (normalizedFile.startsWith('..') || path.isAbsolute(normalizedFile)) {
      throw new LinkPMError(`Security violation: Malicious path traversal in patch: "${currentFile}"`, {
        code: 'ERR_STORE_CORRUPTION',
        hint: 'Patch files cannot reference files outside of the target package directory.'
      });
    }

    const resolvedTarget = path.resolve(targetDir);
    const dest = path.resolve(resolvedTarget, normalizedFile);
    if (!dest.startsWith(resolvedTarget + path.sep) && dest !== resolvedTarget) {
      throw new LinkPMError(`Security violation: Patch path "${currentFile}" escapes target directory`, {
        code: 'ERR_STORE_CORRUPTION'
      });
    }

    if (isDelete) {
      if (fs.existsSync(dest)) {
        try { fs.unlinkSync(dest); } catch {}
      }
      return;
    }

    if (isNew) {
      const parent = path.dirname(dest);
      if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
      const addedLines: string[] = [];
      for (const hunk of currentHunks) {
        for (const l of hunk.lines) {
          if (l.startsWith('+')) addedLines.push(l.slice(1));
        }
      }
      fs.writeFileSync(dest, addedLines.join('\n'), 'utf-8');
      return;
    }

    // Modification
    if (fs.existsSync(dest)) {
      const orig = fs.readFileSync(dest, 'utf-8').split(/\r?\n/);
      let newResult: string[] = [];
      let origIdx = 0;

      for (const hunk of currentHunks) {
        const targetStart = Math.max(0, hunk.origStart - 1);
        while (origIdx < targetStart && origIdx < orig.length) {
          newResult.push(orig[origIdx++]);
        }

        for (const line of hunk.lines) {
          if (line.startsWith(' ')) {
            newResult.push(orig[origIdx] !== undefined ? orig[origIdx] : line.slice(1));
            origIdx++;
          } else if (line.startsWith('+')) {
            newResult.push(line.slice(1));
          } else if (line.startsWith('-')) {
            origIdx++;
          }
        }
      }

      // Append remaining original lines
      while (origIdx < orig.length) {
        newResult.push(orig[origIdx++]);
      }

      fs.writeFileSync(dest, newResult.join('\n'), 'utf-8');
    }
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];

    if (line.startsWith('diff --git')) {
      if (currentFile) {
        if (currentHunk) currentHunks.push(currentHunk);
        flushFile();
      }
      currentFile = null;
      isNew = false;
      isDelete = false;
      currentHunks = [];
      currentHunk = null;
    } else if (line.startsWith('new file mode')) {
      isNew = true;
    } else if (line.startsWith('deleted file mode')) {
      isDelete = true;
    } else if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6).trim();
    } else if (line.startsWith('--- a/') && !currentFile) {
      currentFile = line.slice(6).trim();
    } else if (line.startsWith('@@')) {
      // Hunk header: @@ -origStart,origCount +newStart,newCount @@
      if (currentHunk) {
        currentHunks.push(currentHunk);
      }
      const match = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
      const origStart = match ? parseInt(match[1], 10) : 1;
      const origCount = match && match[2] ? parseInt(match[2], 10) : 1;
      currentHunk = { origStart, origCount, lines: [] };
    } else if (currentHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
      currentHunk.lines.push(line);
    }
  }

  if (currentFile) {
    if (currentHunk) currentHunks.push(currentHunk);
    flushFile();
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
