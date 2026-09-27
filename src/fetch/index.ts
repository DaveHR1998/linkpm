import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as tar from 'tar';
import { IntegrityMismatchError, LinkPMError } from '../utils/errors.js';

export interface DownloadTask {
  name: string;
  version: string;
  url: string;
  targetPath: string;
  integrity?: string;
}

export interface FetchManagerOptions {
  concurrency?: number;
  maxRetries?: number;
  timeoutMs?: number;
}

export class FetchManager {
  private concurrency: number;
  private maxRetries: number;
  private timeoutMs: number;

  constructor(options: FetchManagerOptions = {}) {
    this.concurrency = options.concurrency ?? 8;
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 30000;
  }

  public async downloadTarball(task: DownloadTask): Promise<string> {
    if (fs.existsSync(task.targetPath)) {
      return task.targetPath;
    }

    const parentDir = path.dirname(task.targetPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    const tempPath = `${task.targetPath}.downloading-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        const res = await fetch(task.url, { signal: controller.signal });
        clearTimeout(timer);

        if (!res.ok) {
          throw new LinkPMError(`Failed to download tarball for "${task.name}@${task.version}" (HTTP ${res.status})`, {
            code: 'ERR_REGISTRY_REQUEST',
            packageName: task.name,
            requestedVersion: task.version,
            hint: `URL: ${task.url}`
          });
        }

        const buffer = Buffer.from(await res.arrayBuffer());

        // Verify SHA-512 or SHA-1 integrity checksum if provided
        if (task.integrity) {
          if (task.integrity.startsWith('sha512-')) {
            const expectedHash = task.integrity.slice(7);
            const actualHash = crypto.createHash('sha512').update(buffer).digest('base64');
            if (actualHash !== expectedHash) {
              throw new IntegrityMismatchError(task.name, task.version, `sha512-${expectedHash}`, `sha512-${actualHash}`);
            }
          } else if (task.integrity.startsWith('sha1-')) {
            const expectedHash = task.integrity.slice(5);
            const actualHash = crypto.createHash('sha1').update(buffer).digest('base64');
            if (actualHash !== expectedHash) {
              throw new IntegrityMismatchError(task.name, task.version, `sha1-${expectedHash}`, `sha1-${actualHash}`);
            }
          } else if (/^[a-f0-9]{40}$/i.test(task.integrity)) {
            // Raw 40-character SHA-1 hex
            const actualHex = crypto.createHash('sha1').update(buffer).digest('hex');
            if (actualHex.toLowerCase() !== task.integrity.toLowerCase()) {
              throw new IntegrityMismatchError(task.name, task.version, task.integrity, actualHex);
            }
          }
        }

        fs.writeFileSync(tempPath, buffer);
        fs.renameSync(tempPath, task.targetPath);
        return task.targetPath;
      } catch (err: any) {
        lastError = err;
        if (fs.existsSync(tempPath)) {
          try { fs.unlinkSync(tempPath); } catch {}
        }
        if (err instanceof IntegrityMismatchError) {
          throw err;
        }
        if (attempt < this.maxRetries) {
          const delay = Math.pow(2, attempt) * 400;
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    throw lastError || new LinkPMError(`Download failed for "${task.name}@${task.version}" after ${this.maxRetries} attempts`, {
      code: 'ERR_REGISTRY_REQUEST',
      packageName: task.name
    });
  }

  public async downloadBatch(tasks: DownloadTask[], onProgress?: (completed: number, total: number) => void): Promise<string[]> {
    const results: string[] = [];
    let completed = 0;

    // Concurrency queue
    const executing: Promise<void>[] = [];
    for (const task of tasks) {
      const p = (async () => {
        const pathResult = await this.downloadTarball(task);
        results.push(pathResult);
        completed++;
        if (onProgress) onProgress(completed, tasks.length);
      })();

      executing.push(p);

      if (executing.length >= this.concurrency) {
        await Promise.race(executing);
        // Remove settled promises
        for (let i = executing.length - 1; i >= 0; i--) {
          // Check if resolved
          const isResolved = await Promise.race([executing[i].then(() => true), Promise.resolve(false)]);
          if (isResolved) executing.splice(i, 1);
        }
      }
    }

    await Promise.all(executing);
    return results;
  }

  public static async safeExtractTar(tarballPath: string, destinationDir: string): Promise<void> {
    const resolvedDest = path.resolve(destinationDir);

    if (!fs.existsSync(resolvedDest)) {
      fs.mkdirSync(resolvedDest, { recursive: true });
    }

    await tar.x({
      file: tarballPath,
      cwd: resolvedDest,
      strip: 1, // npm tarballs bundle everything inside package/
      unlink: true, // Replace existing files safely without following outside links
      filter: (entryPath: string, entry: any) => {
        // Zip-Slip Protection: prevent path traversal attacks
        const normalized = path.normalize(entryPath);
        if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
          throw new LinkPMError(`Malicious path traversal detected in tarball: "${entryPath}"`, {
            code: 'ERR_STORE_CORRUPTION',
            hint: 'The package tarball contains unsafe entry paths outside its root directory.'
          });
        }
        const resolvedEntry = path.resolve(resolvedDest, normalized);
        if (!resolvedEntry.startsWith(resolvedDest)) {
          throw new LinkPMError(`Security violation: Tar entry "${entryPath}" escapes target directory`, {
            code: 'ERR_STORE_CORRUPTION'
          });
        }

        // Symlink Traversal Protection
        if (entry && (entry.type === 'SymbolicLink' || entry.type === 'Link') && entry.linkpath) {
          const normLink = path.normalize(entry.linkpath);
          if (normLink.startsWith('..') || path.isAbsolute(normLink)) {
            throw new LinkPMError(`Security violation: Tar symlink "${entryPath}" targets external path: "${entry.linkpath}"`, {
              code: 'ERR_STORE_CORRUPTION'
            });
          }
        }

        return true;
      }
    });
  }
}
