import { promises as fs } from 'node:fs';
import path from 'node:path';

const REPO_OWNER = 'DaveHR1998';
const REPO_NAME = 'linkpm';

export const ISSUES = [
  {
    title: 'feat(cli): shell autocompletion for Bash, Zsh, and Fish',
    labels: ['good first issue', 'enhancement', 'cli'],
    body: `### 🚀 Feature Request: Shell Autocompletion (\`linkpm completion\`)

#### Problem Statement
Currently, \`linkpm\` requires developers to manually type all commands, flags, and options. Adding shell autocompletion makes \`linkpm\` much faster and more pleasant to use in day-to-day development.

#### Proposed Solution
Add a \`linkpm completion [shell]\` command that outputs completion scripts for:
- **Bash** (\`linkpm completion bash\`)
- **Zsh** (\`linkpm completion zsh\`)
- **Fish** (\`linkpm completion fish\`)

Supported commands to autocomplete:
- Core commands: \`install\`, \`add\`, \`remove\`, \`run\`, \`doctor\`, \`approve-builds\`, \`store verify\`, \`diagnostics\`, \`init\`, \`convert\`, \`patch\`
- Flags: \`--save-dev\`, \`--save-optional\`, \`--global\`, \`--frozen-lockfile\`, \`--offline\`, \`--ignore-scripts\`, \`--json\`, \`--verbose\`

#### Implementation Pointers
- Command routing is defined in \`src/cli.ts\` using \`cac\`.
- You can either leverage CAC's completion hooks or write clean, standard completion generators.
- Check how \`npm completion\` or \`pnpm completion\` outputs shell scripts.

#### Acceptance Criteria
- [ ] Running \`linkpm completion bash\` outputs a valid bash-completion function.
- [ ] Running \`linkpm completion zsh\` outputs a valid Zsh \`_linkpm\` completion script.
- [ ] Running \`linkpm completion fish\` outputs a valid Fish completion definition.
- [ ] Includes unit tests in \`tests/\` verifying generated completion scripts contain all CLI commands.`
  },
  {
    title: 'feat(lockfile): bidirectional conversion for yarn.lock and pnpm-lock.yaml',
    labels: ['good first issue', 'enhancement', 'lockfile'],
    body: `### 🚀 Feature Request: Bidirectional conversion for \`yarn.lock\` and \`pnpm-lock.yaml\`

#### Problem Statement
\`linkpm convert\` currently supports migrating \`package-lock.json\` to \`linkpm-lock.json\`. Many projects and monorepos use \`yarn.lock\` (v1 and Berry) or \`pnpm-lock.yaml\`.

#### Proposed Solution
Expand \`linkpm convert\` and lockfile utilities to support:
1. Converting \`yarn.lock\` (v1) -> \`linkpm-lock.json\`
2. Converting \`pnpm-lock.yaml\` (v5 & v6) -> \`linkpm-lock.json\`
3. Optional export flag \`--to=pnpm\` or \`--to=yarn\` to generate foreign lockfiles for interoperability.

#### Implementation Pointers
- Lockfile structure and serialization logic lives in \`src/store/lockfile.ts\`.
- Command flags are in \`src/cli.ts\` under the \`convert\` command.
- Ensure resolved URLs, integrity hashes (SHA-512), and dependency trees are mapped accurately.

#### Acceptance Criteria
- [ ] \`linkpm convert --from yarn.lock\` produces a valid \`linkpm-lock.json\`.
- [ ] \`linkpm convert --from pnpm-lock.yaml\` produces a valid \`linkpm-lock.json\`.
- [ ] Unit tests in \`tests/lockfile.test.ts\` verifying parsing of sample yarn and pnpm lockfiles.`
  },
  {
    title: 'fix(terminal): improve ANSI/Unicode fallback glyphs in standard Windows cmd.exe',
    labels: ['good first issue', 'bug', 'windows'],
    body: `### 🐛 Bug Report / Polish: ANSI and Unicode Fallback Glyphs in Legacy Windows Terminals

#### Problem Statement
When running \`linkpm\` in legacy Windows \`cmd.exe\` or standard PowerShell without UTF-8 codepage (CP 65001) or Windows Terminal enabled, Unicode status glyphs (✔, ✖, ℹ, ⚠, ⚡) can render as mojibake, boxes, or question marks (\`?\`).

#### Proposed Solution
Detect when the process is running in an environment that cannot reliably render UTF-8 glyphs on Windows, and fall back to clean ASCII equivalents:
- ✔ -> \`[OK]\` or \`+\`
- ✖ -> \`[FAIL]\` or \`x\`
- ⚠ -> \`[WARN]\` or \`!\`
- ℹ -> \`[INFO]\` or \`*\`

#### Implementation Pointers
- Terminal formatting and icons are in \`src/utils/\` (or wherever \`picocolors\` and icons are used across CLI logs).
- Check \`process.platform === 'win32'\` and evaluate \`process.env.WT_SESSION\` (Windows Terminal) or \`process.stdout.isTTY\`.

#### Acceptance Criteria
- [ ] Standard Windows console does not render broken characters or question marks.
- [ ] Windows Terminal and modern terminals continue to display vibrant Unicode icons.
- [ ] Existing test suites pass without regression.`
  },
  {
    title: 'test(offline): add zero-network assertion test suite for --offline mode',
    labels: ['good first issue', 'testing', 'reliability'],
    body: `### 🧪 Test Improvement: Zero-Network Assertion Test Suite for \`--offline\` Mode

#### Problem Statement
\`linkpm\` provides an \`--offline\` flag to install packages purely from the local store/cache without touching the network. While the flag is implemented, we need an explicit automated integration test that asserts zero outbound HTTP/HTTPS requests are dispatched during offline installs.

#### Proposed Solution
Add an automated integration test in \`tests/offline.test.ts\`:
1. Populate a temporary store with test packages.
2. Run \`linkpm install --offline\` against a sample \`package.json\`.
3. Assert that:
   - Installation succeeds if all packages exist in store.
   - Zero network requests are made (can intercept or mock \`http\`/\`https\` or set invalid proxy).
   - If a package is missing in offline mode, it fails immediately with a descriptive error code (\`ERR_OFFLINE_CACHE_MISS\`) instead of hanging or retrying.

#### Implementation Pointers
- See existing tests in \`tests/installer.test.ts\` and \`tests/resolver.test.ts\`.
- Native Node test runner (\`node:test\`) and Node \`assert\` are used throughout \`tests/\`.

#### Acceptance Criteria
- [ ] New test file \`tests/offline.test.ts\` added.
- [ ] Verifies offline cache hits succeed with 0 network calls.
- [ ] Verifies offline cache misses fail fast with informative user error.
- [ ] Runs cleanly under \`npm test\`.`
  },
  {
    title: 'feat(diagnostics): add --json flag to linkpm doctor and linkpm diagnostics',
    labels: ['good first issue', 'enhancement', 'dx'],
    body: `### 🚀 Feature Request: \`--json\` Output for \`linkpm doctor\` and \`linkpm diagnostics\`

#### Problem Statement
\`linkpm doctor\` and \`linkpm diagnostics\` output human-readable terminal reports. However, automated CI/CD pipelines, IDE plugins, and agentic workflows need machine-readable structured JSON to parse environment health programmatically.

#### Proposed Solution
Add \`--json\` flag to:
- \`linkpm doctor --json\`
- \`linkpm diagnostics --json\`

Sample JSON Output:
\`\`\`json
{
  "timestamp": "2026-09-29T10:00:00.000Z",
  "healthy": true,
  "nodeVersion": "v22.0.0",
  "store": {
    "path": "C:\\\\Users\\\\...\\\\.linkpm\\\\store",
    "accessible": true,
    "packagesCount": 42
  },
  "filesystem": {
    "supportsHardlinks": true,
    "supportsJunctions": true
  },
  "issues": []
}
\`\`\`

#### Implementation Pointers
- CLI handlers for \`doctor\` and \`diagnostics\` in \`src/cli.ts\`.
- Format results into a serializable object and call \`console.log(JSON.stringify(data, null, 2))\`.

#### Acceptance Criteria
- [ ] Running \`linkpm doctor --json\` prints valid JSON to stdout with exit code 0 when healthy.
- [ ] Returns exit code 1 with structured \`issues\` array when health checks fail.
- [ ] Does not print ANSI color codes or decorative ASCII banners when \`--json\` is supplied.
- [ ] Unit test in \`tests/\` verifying JSON output schema.`
  },
  {
    title: 'feat(ui): support minimal/quiet progress bar when CI=true',
    labels: ['good first issue', 'enhancement', 'ui'],
    body: `### 🚀 Feature Request: Minimal/Quiet Progress Output in CI Environments

#### Problem Statement
In CI/CD environments (GitHub Actions, GitLab CI, CircleCI), interactive terminal animations and dynamic progress bars that use carriage returns (\`\\r\`) often flood build logs with hundreds of redundant lines.

#### Proposed Solution
Automatically detect CI environments (\`process.env.CI\` or \`process.env.CONTINUOUS_INTEGRATION\`) or respect \`--quiet\` / \`--progress=false\`:
- Suppress dynamic redraw loops.
- Print discrete milestone step logs instead, e.g.:
  - \`[1/4] Resolving dependencies...\`
  - \`[2/4] Fetching 18 packages from cache...\`
  - \`[3/4] Linking virtual store...\`
  - \`[4/4] Done in 142ms.\`

#### Implementation Pointers
- Review progress rendering in \`src/installer.ts\` and \`src/utils/\`.
- Check \`Boolean(process.env.CI)\` or command line \`--quiet\` flag.

#### Acceptance Criteria
- [ ] In non-interactive or CI terminals (\`CI=true\`), progress bar does not emit raw ANSI redraw lines.
- [ ] Milestone lines are printed cleanly once per step.
- [ ] Interactive terminal experience on local developer machines remains smooth and animated.`
  }
];

export function getWebUrl(issue) {
  const base = `https://github.com/${REPO_OWNER}/${REPO_NAME}/issues/new`;
  const params = new URLSearchParams({
    title: issue.title,
    body: issue.body,
    labels: issue.labels.join(',')
  });
  return `${base}?${params.toString()}`;
}

async function main() {
  const token = process.env.GITHUB_TOKEN || process.argv[2];

  if (token) {
    console.log(`Authenticating with GitHub API to create ${ISSUES.length} issues on ${REPO_OWNER}/${REPO_NAME}...`);
    for (const issue of ISSUES) {
      const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/issues`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'linkpm-issue-creator',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          title: issue.title,
          body: issue.body,
          labels: issue.labels
        })
      });

      if (!res.ok) {
        const err = await res.text();
        console.error(`Failed to create issue: "${issue.title}": ${res.status} ${err}`);
      } else {
        const created = await res.json();
        console.log(`Created #${created.number}: ${created.html_url}`);
      }
    }
  } else {
    console.log(`=== 1-Click URLs to Open the 6 Good First Issues on GitHub ===\n`);
    ISSUES.forEach((issue, idx) => {
      console.log(`Issue ${idx + 1}: ${issue.title}`);
      console.log(`URL: ${getWebUrl(issue)}\n`);
    });
  }
}

main().catch(console.error);
