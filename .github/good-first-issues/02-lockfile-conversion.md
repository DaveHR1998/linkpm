# Bidirectional Lockfile Conversion for yarn.lock and pnpm-lock.yaml

- **Title**: `feat(lockfile): bidirectional conversion for yarn.lock and pnpm-lock.yaml`
- **Labels**: `good first issue`, `enhancement`, `lockfile`
- **1-Click Creation Link**: [Create Issue on GitHub](https://github.com/DaveHR1998/linkpm/issues/new?title=feat%28lockfile%29%3A+bidirectional+conversion+for+yarn.lock+and+pnpm-lock.yaml&labels=good+first+issue%2Cenhancement%2Clockfile)

---

### 🚀 Feature Request: Bidirectional conversion for `yarn.lock` and `pnpm-lock.yaml`

#### Problem Statement
`linkpm convert` currently supports migrating `package-lock.json` to `linkpm-lock.json`. Many projects and monorepos use `yarn.lock` (v1 and Berry) or `pnpm-lock.yaml`.

#### Proposed Solution
Expand `linkpm convert` and lockfile utilities to support:
1. Converting `yarn.lock` (v1) -> `linkpm-lock.json`
2. Converting `pnpm-lock.yaml` (v5 & v6) -> `linkpm-lock.json`
3. Optional export flag `--to=pnpm` or `--to=yarn` to generate foreign lockfiles for interoperability.

#### Implementation Pointers
- Lockfile structure and serialization logic lives in `src/store/lockfile.ts`.
- Command flags are in `src/cli.ts` under the `convert` command.
- Ensure resolved URLs, integrity hashes (SHA-512), and dependency trees are mapped accurately.

#### Acceptance Criteria
- [ ] `linkpm convert --from yarn.lock` produces a valid `linkpm-lock.json`.
- [ ] `linkpm convert --from pnpm-lock.yaml` produces a valid `linkpm-lock.json`.
- [ ] Unit tests in `tests/lockfile.test.ts` verifying parsing of sample yarn and pnpm lockfiles.
