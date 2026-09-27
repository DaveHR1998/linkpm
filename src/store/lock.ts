import fs from 'node:fs';

export interface LockMetadata {
  pid: number;
  time: number;
}

export interface FileLockOptions {
  timeoutMs?: number;
  staleThresholdMs?: number;
  staleTimeoutMs?: number;
}

export class FileLock {
  private static activeLocks: Set<string> = new Set();
  private static handlersRegistered = false;

  private static registerCleanupHandlers(): void {
    if (FileLock.handlersRegistered) return;
    FileLock.handlersRegistered = true;

    const cleanup = () => {
      FileLock.releaseAll();
    };

    process.on('SIGINT', () => {
      cleanup();
      process.exit(130);
    });
    process.on('SIGTERM', () => {
      cleanup();
      process.exit(143);
    });
    process.on('exit', () => {
      cleanup();
    });
  }

  public static releaseAll(): void {
    for (const lockPath of FileLock.activeLocks) {
      try {
        if (fs.existsSync(lockPath)) {
          fs.unlinkSync(lockPath);
        }
      } catch {}
    }
    FileLock.activeLocks.clear();
  }

  public static async acquire(
    lockFilePath: string,
    timeoutMsOrOptions?: number | FileLockOptions,
    staleThresholdMsParam?: number
  ): Promise<void> {
    FileLock.registerCleanupHandlers();

    const opts: FileLockOptions = typeof timeoutMsOrOptions === 'object' && timeoutMsOrOptions !== null
      ? timeoutMsOrOptions
      : { timeoutMs: timeoutMsOrOptions, staleThresholdMs: staleThresholdMsParam };

    const timeoutMs = opts.timeoutMs ?? 10000;
    const staleThresholdMs = opts.staleThresholdMs ?? opts.staleTimeoutMs ?? 60000;
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
        FileLock.activeLocks.add(lockFilePath);
        return; // Successfully locked
      } catch (err: any) {
        if (err.code === 'EEXIST') {
          // Check if lock is stale
          try {
            const raw = fs.readFileSync(lockFilePath, 'utf-8');
            const data: LockMetadata = JSON.parse(raw);
            const lockTime = data.time || (data as any).timestamp || 0;
            const isOld = Date.now() - lockTime > staleThresholdMs;

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
    FileLock.activeLocks.delete(lockFilePath);
    try {
      if (fs.existsSync(lockFilePath)) {
        fs.unlinkSync(lockFilePath);
      }
    } catch {}
  }

  public static async withLock<T>(
    lockFilePath: string,
    fn: () => Promise<T>,
    timeoutMsOrOptions?: number | FileLockOptions
  ): Promise<T> {
    await FileLock.acquire(lockFilePath, timeoutMsOrOptions);
    try {
      return await fn();
    } finally {
      FileLock.release(lockFilePath);
    }
  }
}
