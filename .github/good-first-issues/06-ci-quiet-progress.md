# Minimal/Quiet Progress Bar when CI=true

- **Title**: `feat(ui): support minimal/quiet progress bar when CI=true`
- **Labels**: `good first issue`, `enhancement`, `ui`
- **1-Click Creation Link**: [Create Issue on GitHub](https://github.com/DaveHR1998/linkpm/issues/new?title=feat%28ui%29%3A+support+minimal%2Fquiet+progress+bar+when+CI%3Dtrue&labels=good+first+issue%2Cenhancement%2Cui)

---

### 🚀 Feature Request: Minimal/Quiet Progress Output in CI Environments

#### Problem Statement
In CI/CD environments (GitHub Actions, GitLab CI, CircleCI), interactive terminal animations and dynamic progress bars that use carriage returns (`\r`) often flood build logs with hundreds of redundant lines.

#### Proposed Solution
Automatically detect CI environments (`process.env.CI` or `process.env.CONTINUOUS_INTEGRATION`) or respect `--quiet` / `--progress=false`:
- Suppress dynamic redraw loops.
- Print discrete milestone step logs instead, e.g.:
  - `[1/4] Resolving dependencies...`
  - `[2/4] Fetching 18 packages from cache...`
  - `[3/4] Linking virtual store...`
  - `[4/4] Done in 142ms.`

#### Implementation Pointers
- Review progress rendering in `src/installer.ts` and `src/utils/`.
- Check `Boolean(process.env.CI)` or command line `--quiet` flag.

#### Acceptance Criteria
- [ ] In non-interactive or CI terminals (`CI=true`), progress bar does not emit raw ANSI redraw lines.
- [ ] Milestone lines are printed cleanly once per step.
- [ ] Interactive terminal experience on local developer machines remains smooth and animated.
