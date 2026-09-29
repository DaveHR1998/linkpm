# JSON Output for Doctor & Diagnostics

- **Title**: `feat(diagnostics): add --json flag to linkpm doctor and linkpm diagnostics`
- **Labels**: `good first issue`, `enhancement`, `dx`
- **1-Click Creation Link**: [Create Issue on GitHub](https://github.com/DaveHR1998/linkpm/issues/new?title=feat%28diagnostics%29%3A+add+--json+flag+to+linkpm+doctor+and+linkpm+diagnostics&labels=good+first+issue%2Cenhancement%2Cdx)

---

### 🚀 Feature Request: `--json` Output for `linkpm doctor` and `linkpm diagnostics`

#### Problem Statement
`linkpm doctor` and `linkpm diagnostics` output human-readable terminal reports. However, automated CI/CD pipelines, IDE plugins, and agentic workflows need machine-readable structured JSON to parse environment health programmatically.

#### Proposed Solution
Add `--json` flag to:
- `linkpm doctor --json`
- `linkpm diagnostics --json`

Sample JSON Output:
```json
{
  "timestamp": "2026-09-29T10:00:00.000Z",
  "healthy": true,
  "nodeVersion": "v22.0.0",
  "store": {
    "path": "C:\\Users\\...\\.linkpm\\store",
    "accessible": true,
    "packagesCount": 42
  },
  "filesystem": {
    "supportsHardlinks": true,
    "supportsJunctions": true
  },
  "issues": []
}
```

#### Implementation Pointers
- CLI handlers for `doctor` and `diagnostics` in `src/cli.ts`.
- Format results into a serializable object and call `console.log(JSON.stringify(data, null, 2))`.

#### Acceptance Criteria
- [ ] Running `linkpm doctor --json` prints valid JSON to stdout with exit code 0 when healthy.
- [ ] Returns exit code 1 with structured `issues` array when health checks fail.
- [ ] Does not print ANSI color codes or decorative ASCII banners when `--json` is supplied.
- [ ] Unit test in `tests/` verifying JSON output schema.
