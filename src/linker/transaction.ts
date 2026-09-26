import fs from 'node:fs';
import path from 'node:path';
import { linkPackage, unlinkPackage, ensureNodeModules } from '../linker.js';
import { LinkPMError } from '../utils/errors.js';

export interface StagedLink {
  packageName: string;
  storePackageDir: string;
}

export class InstallTransaction {
  private projectRoot: string;
  private stagedLinks: StagedLink[] = [];
  private committed: boolean = false;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
  }

  public stage(packageName: string, storePackageDir: string): void {
    this.stagedLinks.push({ packageName, storePackageDir });
  }

  public async commit(): Promise<{ linkedCount: number; binsLinked: string[] }> {
    ensureNodeModules(this.projectRoot);
    const allBins: string[] = [];
    const successfulLinks: string[] = [];

    try {
      for (const item of this.stagedLinks) {
        const res = linkPackage(this.projectRoot, item.packageName, item.storePackageDir);
        successfulLinks.push(item.packageName);
        allBins.push(...res.binsLinked);
      }

      this.committed = true;
      return {
        linkedCount: successfulLinks.length,
        binsLinked: allBins
      };
    } catch (err: any) {
      // Rollback on failure
      this.rollback(successfulLinks);
      throw new LinkPMError(`Installation transaction failed and was rolled back: ${err.message}`, {
        code: 'ERR_STORE_CORRUPTION',
        hint: 'Existing node_modules was preserved without partial corruption.'
      });
    }
  }

  public rollback(packagesToUnlink: string[]): void {
    if (this.committed) return;

    for (const pkg of packagesToUnlink) {
      try {
        unlinkPackage(this.projectRoot, pkg);
      } catch {}
    }
  }
}
