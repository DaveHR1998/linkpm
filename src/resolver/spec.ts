export type SpecType = 'registry' | 'alias' | 'file' | 'link' | 'git' | 'workspace' | 'tarball';

export interface ParsedSpec {
  raw: string;
  type: SpecType;
  alias?: string;           // Name used in package.json (if aliased)
  name: string;            // Real package name
  range: string;           // Semver range, dist-tag, commit, or subpath
  target?: string;         // For file:, link:, git:, tarball:
}

export function parsePackageSpec(input: string): ParsedSpec {
  const trimmed = input.trim();

  // 1. Alias syntax: name@npm:real-name@range
  // e.g. "my-react@npm:react@^18.2.0" or "npm:bar@^1.0.0"
  if (trimmed.includes('npm:')) {
    const atNpmIdx = trimmed.indexOf('@npm:');
    if (atNpmIdx !== -1) {
      const alias = trimmed.slice(0, atNpmIdx);
      const remainder = trimmed.slice(atNpmIdx + 5); // after "@npm:"
      const parsedReal = parseRegistrySpec(remainder);
      return {
        raw: trimmed,
        type: 'alias',
        alias,
        name: parsedReal.name,
        range: parsedReal.range
      };
    }

    if (trimmed.startsWith('npm:')) {
      const remainder = trimmed.slice(4);
      const parsedReal = parseRegistrySpec(remainder);
      return {
        raw: trimmed,
        type: 'alias',
        alias: parsedReal.name,
        name: parsedReal.name,
        range: parsedReal.range
      };
    }
  }

  // 2. Workspace protocol: "workspace:*", "workspace:^1.0.0"
  if (trimmed.startsWith('workspace:')) {
    const range = trimmed.slice('workspace:'.length) || '*';
    return {
      raw: trimmed,
      type: 'workspace',
      name: '',
      range
    };
  }

  // 3. Local paths: "file:...", "link:..."
  if (trimmed.startsWith('file:') || trimmed.startsWith('link:')) {
    const prefix = trimmed.startsWith('file:') ? 'file' : 'link';
    const target = trimmed.slice(prefix.length + 1);
    return {
      raw: trimmed,
      type: prefix as 'file' | 'link',
      name: '',
      range: target,
      target
    };
  }

  // 4. Git URLs: "git+https:...", "git+ssh:...", "github:..."
  if (
    trimmed.startsWith('git+') ||
    trimmed.startsWith('git://') ||
    trimmed.startsWith('github:') ||
    (trimmed.includes('.git') && (trimmed.startsWith('http://') || trimmed.startsWith('https://')))
  ) {
    let cleanUrl = trimmed;
    if (trimmed.startsWith('github:')) {
      cleanUrl = `https://github.com/${trimmed.slice(7)}.git`;
    }
    return {
      raw: trimmed,
      type: 'git',
      name: '',
      range: 'HEAD',
      target: cleanUrl
    };
  }

  // 5. Tarball URLs: "https://.../pkg.tgz"
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    if (trimmed.endsWith('.tgz') || trimmed.endsWith('.tar.gz')) {
      return {
        raw: trimmed,
        type: 'tarball',
        name: '',
        range: 'latest',
        target: trimmed
      };
    }
  }

  // 6. Standard Registry Package: "express", "express@^4.18.0", "@types/node@18.0.0"
  const parsed = parseRegistrySpec(trimmed);
  return {
    raw: trimmed,
    type: 'registry',
    name: parsed.name,
    range: parsed.range
  };
}

function parseRegistrySpec(spec: string): { name: string; range: string } {
  let name = spec.trim();
  let range = 'latest';

  if (spec.startsWith('@')) {
    // Scoped package e.g. @types/node@18.0.0
    const secondAt = spec.indexOf('@', 1);
    if (secondAt !== -1) {
      name = spec.slice(0, secondAt);
      range = spec.slice(secondAt + 1) || 'latest';
    }
  } else {
    // Unscoped package e.g. express@^4.18.0
    const firstAt = spec.indexOf('@');
    if (firstAt !== -1) {
      name = spec.slice(0, firstAt);
      range = spec.slice(firstAt + 1) || 'latest';
    }
  }

  return { name, range };
}
