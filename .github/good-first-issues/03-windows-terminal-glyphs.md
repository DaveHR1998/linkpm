# ANSI and Unicode Fallback Glyphs in Legacy Windows Terminals

- **Title**: `fix(terminal): improve ANSI/Unicode fallback glyphs in standard Windows cmd.exe`
- **Labels**: `good first issue`, `bug`, `windows`
- **1-Click Creation Link**: [Create Issue on GitHub](https://github.com/DaveHR1998/linkpm/issues/new?title=fix%28terminal%29%3A+improve+ANSI%2FUnicode+fallback+glyphs+in+standard+Windows+cmd.exe&labels=good+first+issue%2Cbug%2Cwindows)

---

### 🐛 Bug Report / Polish: ANSI and Unicode Fallback Glyphs in Legacy Windows Terminals

#### Problem Statement
When running `linkpm` in legacy Windows `cmd.exe` or standard PowerShell without UTF-8 codepage (CP 65001) or Windows Terminal enabled, Unicode status glyphs (✔, ✖, ℹ, ⚠, ⚡) can render as mojibake, boxes, or question marks (`?`).

#### Proposed Solution
Detect when the process is running in an environment that cannot reliably render UTF-8 glyphs on Windows, and fall back to clean ASCII equivalents:
- ✔ -> `[OK]` or `+`
- ✖ -> `[FAIL]` or `x`
- ⚠ -> `[WARN]` or `!`
- ℹ -> `[INFO]` or `*`

#### Implementation Pointers
- Terminal formatting and icons are in `src/utils/` (or wherever `picocolors` and icons are used across CLI logs).
- Check `process.platform === 'win32'` and evaluate `process.env.WT_SESSION` (Windows Terminal) or `process.stdout.isTTY`.

#### Acceptance Criteria
- [ ] Standard Windows console does not render broken characters or question marks.
- [ ] Windows Terminal and modern terminals continue to display vibrant Unicode icons.
- [ ] Existing test suites pass without regression.
