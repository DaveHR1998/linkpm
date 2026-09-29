# Zero-Network Assertion Test Suite for --offline Mode

- **Title**: `test(offline): add zero-network assertion test suite for --offline mode`
- **Labels**: `good first issue`, `testing`, `reliability`
- **1-Click Creation Link**: [Create Issue on GitHub](https://github.com/DaveHR1998/linkpm/issues/new?title=test%28offline%29%3A+add+zero-network+assertion+test+suite+for+--offline+mode&labels=good+first+issue%2Ctesting%2Creliability)

---

### 🧪 Test Improvement: Zero-Network Assertion Test Suite for `--offline` Mode

#### Problem Statement
`linkpm` provides an `--offline` flag to install packages purely from the local store/cache without touching the network. While the flag is implemented, we need an explicit automated integration test that asserts zero outbound HTTP/HTTPS requests are dispatched during offline installs.

#### Proposed Solution
Add an automated integration test in `tests/offline.test.ts`:
1. Populate a temporary store with test packages.
2. Run `linkpm install --offline` against a sample `package.json`.
3. Assert that:
   - Installation succeeds if all packages exist in store.
   - Zero network requests are made (can intercept or mock `http`/`https` or set invalid proxy).
   - If a package is missing in offline mode, it fails immediately with a descriptive error code (`ERR_OFFLINE_CACHE_MISS`) instead of hanging or retrying.

#### Implementation Pointers
- See existing tests in `tests/installer.test.ts` and `tests/resolver.test.ts`.
- Native Node test runner (`node:test`) and Node `assert` are used throughout `tests/`.

#### Acceptance Criteria
- [ ] New test file `tests/offline.test.ts` added.
- [ ] Verifies offline cache hits succeed with 0 network calls.
- [ ] Verifies offline cache misses fail fast with informative user error.
- [ ] Runs cleanly under `npm test`.
