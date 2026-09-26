import pc from 'picocolors';

export type ErrorCode =
  | 'ERR_PACKAGE_NOT_FOUND'
  | 'ERR_VERSION_NOT_FOUND'
  | 'ERR_PEER_CONFLICT'
  | 'ERR_INTEGRITY_MISMATCH'
  | 'ERR_PLATFORM_UNSUPPORTED'
  | 'ERR_OFFLINE_NOT_CACHED'
  | 'ERR_LOCKFILE_MISMATCH'
  | 'ERR_REGISTRY_REQUEST'
  | 'ERR_INVALID_SPEC'
  | 'ERR_PRESET_NOT_FOUND'
  | 'ERR_STORE_CORRUPTION'
  | 'ERR_COMMAND_FAILED'
  | 'ERR_PROJECT_NOT_FOUND'
  | 'ERR_SCRIPT_NOT_FOUND';

export interface LinkPMErrorOptions {
  code: ErrorCode;
  packageName?: string;
  requestedVersion?: string;
  resolvedVersion?: string;
  dependencyChain?: string[];
  hint?: string;
  cause?: Error;
}

export class LinkPMError extends Error {
  public readonly code: ErrorCode;
  public readonly packageName?: string;
  public readonly requestedVersion?: string;
  public readonly resolvedVersion?: string;
  public readonly dependencyChain?: string[];
  public readonly hint?: string;

  constructor(message: string, options: LinkPMErrorOptions) {
    super(message);
    this.name = 'LinkPMError';
    this.code = options.code;
    this.packageName = options.packageName;
    this.requestedVersion = options.requestedVersion;
    this.resolvedVersion = options.resolvedVersion;
    this.dependencyChain = options.dependencyChain;
    this.hint = options.hint;
    if (options.cause) {
      this.cause = options.cause;
    }
  }

  public format(): string {
    const lines: string[] = [];
    lines.push(`${pc.bold(pc.red(`✖ [${this.code}]`))} ${pc.bold(this.message)}`);

    if (this.packageName) {
      lines.push(`  ${pc.dim('Package:')} ${pc.cyan(this.packageName)}${this.requestedVersion ? pc.dim(` (requested: ${this.requestedVersion})`) : ''}`);
    }

    if (this.dependencyChain && this.dependencyChain.length > 0) {
      lines.push(`  ${pc.dim('Dependency chain:')}`);
      lines.push(`    ${this.dependencyChain.join(pc.dim(' ➔ '))}`);
    }

    if (this.hint) {
      lines.push(`  ${pc.bold(pc.yellow('💡 Suggested Solution:'))} ${this.hint}`);
    }

    return lines.join('\n');
  }
}

export class PeerConflictError extends LinkPMError {
  constructor(
    parentPackage: string,
    peerName: string,
    requiredRange: string,
    resolvedVersion: string,
    dependencyChain: string[] = []
  ) {
    super(`Peer dependency conflict for "${peerName}"`, {
      code: 'ERR_PEER_CONFLICT',
      packageName: peerName,
      requestedVersion: requiredRange,
      resolvedVersion,
      dependencyChain,
      hint: `Install a version of "${peerName}" satisfying "${requiredRange}", or use dependency overrides.`
    });
  }
}

export class IntegrityMismatchError extends LinkPMError {
  constructor(packageName: string, version: string, expected: string, actual: string) {
    super(`Integrity verification failed for "${packageName}@${version}"`, {
      code: 'ERR_INTEGRITY_MISMATCH',
      packageName,
      requestedVersion: version,
      hint: `Expected: ${expected}\nActual:   ${actual}\nThe downloaded archive may be corrupted or compromised. Clear cache and retry.`
    });
  }
}
