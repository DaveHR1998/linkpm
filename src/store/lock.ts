import fs from 'node:fs';

export interface LockMetadata {
  pid: number;
  time: number;
}

export class FileLock {
  public static async acquire(lockFilePath: string, timeoutMs: number = 10000, staleThresholdMs: number = 60000): Promise<void> {
    const startTime = Date.now();

    while (true) {
      try {
        const metadata: LockMetadata = {
          pid: process.pid,
          time: Date.now()
        };
        const fd = fs.openSync(lockFilePath, 'wx'); // O_CREAT | O_EXCL
        fs.writeFileSync(fd, JSON.stringify(metadata), 'utf-8');
        fs.closeSync(fd);
        return; // Successfully locked
      } catch (err: any) {
        if (err.code === 'EEXIST') {
          // Check if lock is stale
          try {
            const raw = fs.readFileSync(lockFilePath, 'utf-8');
            const data: LockMetadata = JSON.parse(raw);
            const isOld = Date.now() - data.time > staleThresholdMs;

            // Check if process still alive
            let processDead = false;
            try {
              process.kill(data.pid, 0);
            } catch {
              processDead = true;
            }

            if (isOld || processDead) {
              // Stale lock: break it
              try { fs.unlinkSync(lockFilePath); } catch {}
              continue; // Retry acquisition immediately
            }
          } catch {}

          if (Date.now() - startTime > timeoutMs) {
            throw new Error(`Timed out waiting for lock on "${lockFilePath}" after ${timeoutMs}ms`);
          }

          // Backoff before retry
          await new Promise(r => setTimeout(r, 60));
          continue;
        }
        throw err;
      }
    }
  }

  public static release(lockFilePath: string): void {
    try {
      if (fs.existsSync(lockFilePath)) {
        fs.unlinkSync(lockFilePath);
      }
    } catch {}
  }

  public static async withLock<T>(lockFilePath: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    await FileLock.acquire(lockFilePath, timeoutMs);
    try {
      return await fn();
    } finally {
      FileLock.release(lockFilePath);
    }
  }
}
