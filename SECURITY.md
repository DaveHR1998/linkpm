# Security Policy

The **linkpm** team takes security seriously. As a package manager responsible for resolving, verifying, and executing code across development and production environments, maintaining strict security guarantees is a core project principle.

---

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1.0 | :x:                |

---

## 🔒 Built-in Security Defenses

`linkpm` enforces several security mechanisms by default:

1. **Default-Deny Lifecycle Scripts**:
   Package `install`, `preinstall`, and `postinstall` scripts are blocked by default. Scripts are only executed if explicitly approved via `linkpm approve-builds` or listed in the project's `onlyBuiltDependencies` configuration.
2. **Release-Age Cooldown (`minimumReleaseAge`)**:
   By default, `linkpm` enforces a 24-hour release cooldown window (`86400` seconds) on newly published package versions to mitigate day-zero software supply chain compromises. Urgent hotfixes can be exempted via `releaseAgeExclude` or `--ignore-release-age`.
3. **Exotic Transitive Dependency Blocking**:
   Transitive dependencies referencing raw git repositories, remote tarball URLs, or local file paths are blocked by default. Top-level git dependencies are pinned to exact commit SHAs.
4. **Content Addressability & SHA-512 Verification**:
   All downloaded tarballs and extracted store files are hashed and validated against SHA-512 integrity checksums before entering the global store.
5. **Path Traversal (Zip-Slip) Defense**:
   Patches and unpacked archives are constrained to the target package root directory. Any attempt to write outside target bounds is blocked with a security violation error.
6. **Store Verification (`linkpm store verify`)**:
   The store's file integrity can be re-validated at any time via `linkpm store verify` to detect tampering or filesystem corruption, with an optional `--fix` recovery flag.

---

## 🚨 Reporting a Vulnerability

If you discover a security vulnerability in linkpm, please do **not** report it via a public GitHub issue.

Instead, please report vulnerabilities by email or private advisory:
- **Email**: `security@linkpm.dev` (or open a GitHub Private Vulnerability Advisory via GitHub Security tab)
- **Maintainer**: Dawit Yetmgeta

Please include in your report:
- A clear description of the vulnerability and its potential impact.
- Step-by-step reproduction instructions or a minimal proof of concept (PoC).
- Your proposed fix or mitigation (if available).

### Response Timeline
- **Acknowledgement**: Within 48 hours.
- **Assessment & Triage**: Within 5 business days.
- **Fix & Advisory Release**: Coordinated with the reporter before public disclosure.
