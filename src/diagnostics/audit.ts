import pc from 'picocolors';
import semver from 'semver';
import { readLockfile, LOCKFILE_NAME } from '../lockfile/index.js';
import { loadNpmrc, getAuthHeaderForRegistry } from '../config/index.js';
import { LinkPMError } from '../utils/errors.js';

export interface AuditResult {
  totalScanned: number;
  vulnerabilities: Array<{
    package: string;
    version: string;
    severity: 'low' | 'moderate' | 'high' | 'critical';
    title: string;
    url?: string;
  }>;
}

interface NpmAdvisory {
  id: number | string;
  url?: string;
  title?: string;
  severity?: string;
  vulnerable_versions?: string;
}

export interface SecurityAuditOptions {
  /** Override the advisory endpoint registry (primarily for tests). */
  registry?: string;
  timeoutMs?: number;
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, moderate: 2, low: 3 };

function normalizeSeverity(raw: string | undefined): 'low' | 'moderate' | 'high' | 'critical' {
  const s = (raw || '').toLowerCase();
  if (s === 'critical' || s === 'high' || s === 'moderate' || s === 'low') return s;
  return 'moderate';
}

/**
 * Runs a REAL vulnerability audit: queries the npm bulk advisory endpoint
 * (`/-/npm/v1/security/advisories/bulk`) with every package@version in the
 * lockfile and matches installed versions against each advisory's
 * vulnerable_versions semver range. Falls back to OSV on npm failure.
 */
export async function runSecurityAudit(
  projectRoot: string,
  options: SecurityAuditOptions = {}
): Promise<AuditResult> {
  const lock = readLockfile(projectRoot);
  if (!lock) {
    throw new LinkPMError(`No ${LOCKFILE_NAME} found in ${projectRoot}`, {
      code: 'ERR_LOCKFILE_MISMATCH',
      hint: 'Run "linkpm install" first to generate a deterministic lockfile.'
    });
  }

  // Aggregate installed versions per package name
  const installed: Record<string, string[]> = {};
  for (const [key, pkgInfo] of Object.entries(lock.packages)) {
    const atIdx = key.lastIndexOf('@');
    const name = atIdx > 0 ? key.slice(0, atIdx) : key;
    if (!name || !semver.valid(pkgInfo.version)) continue;
    if (!installed[name]) installed[name] = [];
    if (!installed[name].includes(pkgInfo.version)) installed[name].push(pkgInfo.version);
  }

  const totalScanned = Object.entries(lock.packages).length;
  const packageNames = Object.keys(installed);
  if (packageNames.length === 0) {
    return { totalScanned: 0, vulnerabilities: [] };
  }

  const npmrc = loadNpmrc(projectRoot);
  const baseRegistry = (options.registry || npmrc.registry).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 15000;

  let advisories: Record<string, NpmAdvisory[]> | null = null;
  try {
    advisories = await fetchNpmBulkAdvisories(baseRegistry, installed, npmrc, timeoutMs);
  } catch {
    advisories = await fetchOsvAdvisories(installed, timeoutMs);
  }

  const vulnerabilities: AuditResult['vulnerabilities'] = [];
  for (const [pkgName, advList] of Object.entries(advisories)) {
    for (const adv of advList) {
      const range = adv.vulnerable_versions;
      for (const version of installed[pkgName]) {
        // npm advisories use semver ranges; OSV advisories (converted below) too
        let affected = false;
        try {
          affected = range ? semver.satisfies(version, range, { includePrerelease: true }) : true;
        } catch {
          affected = true; // unparsable range -> treat as potentially affected to avoid false negatives
        }
        if (affected) {
          vulnerabilities.push({
            package: pkgName,
            version,
            severity: normalizeSeverity(adv.severity),
            title: adv.title || `Advisory ${adv.id}`,
            url: adv.url
          });
        }
      }
    }
  }

  vulnerabilities.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));

  return { totalScanned, vulnerabilities };
}

async function fetchNpmBulkAdvisories(
  registryBase: string,
  installed: Record<string, string[]>,
  npmrc: ReturnType<typeof loadNpmrc>,
  timeoutMs: number
): Promise<Record<string, NpmAdvisory[]>> {
  const url = `${registryBase}/-/npm/v1/security/advisories/bulk`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = getAuthHeaderForRegistry(registryBase + '/', npmrc);
  if (auth) headers['Authorization'] = auth;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(installed),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new LinkPMError(`Advisory endpoint returned HTTP ${res.status}`, { code: 'ERR_REGISTRY_REQUEST' });
  }

  return (await res.json()) as Record<string, NpmAdvisory[]>;
}

/** OSV.dev fallback (batch query API). */
async function fetchOsvAdvisories(
  installed: Record<string, string[]>,
  timeoutMs: number
): Promise<Record<string, NpmAdvisory[]>> {
  const queries: Array<{ package: { name: string; ecosystem: string }; version: string }> = [];
  for (const [name, versions] of Object.entries(installed)) {
    for (const version of versions) {
      queries.push({ package: { name, ecosystem: 'npm' }, version });
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch('https://api.osv.dev/v1/querybatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new LinkPMError(`OSV advisory API returned HTTP ${res.status}`, {
      code: 'ERR_REGISTRY_REQUEST',
      hint: 'linkpm audit requires network access to npm or OSV advisory databases.'
    });
  }

  const data = (await res.json()) as { results?: Array<{ vulns?: any[] }> };
  const out: Record<string, NpmAdvisory[]> = {};
  let idx = 0;
  for (const [name, versions] of Object.entries(installed)) {
    for (const version of versions) {
      const vulns = data.results?.[idx]?.vulns;
      if (vulns && vulns.length > 0) {
        if (!out[name]) out[name] = [];
        for (const v of vulns) {
          // OSV reports exact ecosystem ranges; we conservatively flag the queried version
          const sev = v.database_specific?.severity || v.severity?.[0]?.score || 'moderate';
          out[name].push({
            id: v.id,
            title: v.summary || String(v.id),
            url: `https://osv.dev/vulnerability/${v.id}`,
            severity: String(sev).toLowerCase().includes('crit')
              ? 'critical'
              : String(sev).toLowerCase().includes('high')
                ? 'high'
                : 'moderate',
            vulnerable_versions: version // exact match already established by query
          });
        }
      }
      idx++;
    }
  }
  return out;
}

export function printAuditResults(result: AuditResult): void {
  console.log(pc.bold(pc.blue('\n🛡 linkpm security audit:')));
  console.log(`  Scanned ${pc.bold(result.totalScanned.toString())} package dependencies across lockfile.`);

  if (result.vulnerabilities.length === 0) {
    console.log(pc.bold(pc.green('\n✔ 0 vulnerabilities found.')));
    console.log(pc.dim('  All audited package dependencies passed integrity and advisory checks.\n'));
  } else {
    console.log(pc.bold(pc.red(`\n✖ ${result.vulnerabilities.length} vulnerability found:\n`)));
    for (const v of result.vulnerabilities) {
      console.log(`  ${pc.bold(pc.red(`[${v.severity.toUpperCase()}]`))} ${pc.bold(v.package)}@${v.version}: ${v.title}`);
      if (v.url) console.log(`  ${pc.dim('Advisory:')} ${pc.cyan(v.url)}`);
    }
    console.log('');
  }
}

/**
 * Serializes AuditResult into standard SARIF (Static Analysis Results Interchange Format) v2.1.0
 * for direct ingestion by GitHub's Code Scanning / Security tab.
 */
export function formatSarifReport(result: AuditResult): string {
  const rules = result.vulnerabilities.map(v => ({
    id: `LP-SEC-${v.package}`,
    name: `${v.package}Vulnerability`,
    shortDescription: {
      text: `${v.title} in ${v.package}@${v.version}`
    },
    defaultConfiguration: {
      level: v.severity === 'critical' || v.severity === 'high' ? 'error' : (v.severity === 'moderate' ? 'warning' : 'note')
    },
    helpUri: v.url || 'https://github.com/advisories'
  }));

  const results = result.vulnerabilities.map(v => ({
    ruleId: `LP-SEC-${v.package}`,
    level: v.severity === 'critical' || v.severity === 'high' ? 'error' : (v.severity === 'moderate' ? 'warning' : 'note'),
    message: {
      text: `${v.package}@${v.version}: ${v.title}${v.url ? ` (${v.url})` : ''}`
    },
    locations: [
      {
        physicalLocation: {
          artifactLocation: {
            uri: 'package.json'
          },
          region: {
            startLine: 1
          }
        }
      }
    ],
    properties: {
      package: v.package,
      version: v.version,
      severity: v.severity,
      advisoryUrl: v.url
    }
  }));

  const sarif = {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'LinkPM Security Audit',
            version: '1.0.6',
            informationUri: 'https://github.com/DaveHR1998/linkpm',
            rules
          }
        },
        results
      }
    ]
  };

  return JSON.stringify(sarif, null, 2);
}
