---
name: dependency-security
description: Add host-side dependency scanning for npm, pnpm, pip, uv, Poetry, Maven, Gradle, Cargo, Go and NuGet, using a pinned OSV-Scanner and Area51 quarantine policy.
---

# Dependency security

Apply this utility skill to an Area51 checkout containing the Python package-risk gate. The skill adds a host preflight scanner; its canonical implementation and tests live in `payload/`.

## Install

1. Run `node .claude/skills/dependency-security/install.mjs` from the checkout. Reapplying the same version is idempotent; changed installed files are preserved by refusing replacement.
2. Run `node .claude/skills/dependency-security/download.mjs` to install the pinned OSV-Scanner 2.7.0 into `data/tools/`. The downloader verifies the platform-specific SHA-256 from `pins.json`, recorded from the official GitHub release assets. This verifies consistency with the reviewed pin, not independent release provenance.
3. In the **host service environment**, set `AREA51_DEPENDENCY_SECURITY=required` and `AREA51_DEPENDENCY_SCANNER` to the absolute path printed by the downloader. Restart the host service through the deployment's normal process. Leave these variables outside agent/session environments.
4. Run `pnpm exec tsc --noEmit` and `pnpm exec vitest run src/dependency-security.test.ts` in the composed checkout.
5. Run `pnpm exec tsx .claude/skills/dependency-security/prove.ts` with the same host environment to exercise all ten manager fixtures against the current OSV service. Review `.area51/diagnostics/dependency-security/summary.md` and `report.json`. The GitHub `Dependency security across managers` workflow performs the composed tests and real lookups on Linux, Windows and macOS.

## Behavior

Each normal Agent Gate preflight and each explicit gate scan invokes the installed scanner. With required mode unset, `dependency_scan.status` is `disabled`; installing files alone does not silently activate network lookups. Required mode without a verified binary, inventory, parser coverage or available service produces an incomplete finding and prevents a clean security result. The CLI scan reports findings; the runtime controller applies its decision.

The host stages only bounded regular dependency files from the group tree. Agent-provided OSV configuration, ignore rules, code and environment files are omitted. A host-owned empty scanner configuration takes precedence. The scanner runs with a minimal environment and no provider/GitHub secrets; Maven resolution and Go/Rust call/build analysis are explicitly disabled. It runs `scan`, never `fix`, package install, or a language build.

The online lookup sends package names and versions to OSV. Enable required mode only where that disclosure and network route are appropriate. Credentials are not needed by the OSV service. An unavailable service or invalid result is unknown coverage and requires review; it never becomes a clean scan.

Active OSV vulnerability matches become high findings under a conservative policy, regardless of published severity. A vulnerability match is **not proof of compromise or exploitation**. The existing host policy chooses quarantine with Incus or block without the required isolation. Local LiteLLM emergency rules still match known malicious releases extracted from uv/Poetry inventories if a new incident has not yet reached OSV.

On a completed scan with findings, input files, hashes and the normalized result are preserved in a host temporary evidence directory and linked from `report.quarantine.files`. Preserve them before host temporary-file cleanup. VM quarantine snapshots follow the runtime's existing preservation rules.

## Coverage

| Manager            | Input                                                                      |
| ------------------ | -------------------------------------------------------------------------- |
| npm / pnpm         | package-lock.json / pnpm-lock.yaml                                         |
| pip / uv / Poetry  | exact-pinned requirements.txt or requirements.lock / uv.lock / poetry.lock |
| Maven / Gradle     | pom.xml / gradle.lockfile or buildscript-gradle.lockfile                   |
| Cargo / Go / NuGet | Cargo.lock / go.mod / packages.lock.json or packages.config                |

Nested files are included within documented resource budgets. The underlying scanner also accepts the staged Yarn, Bun, Pipenv, PDM and Python pylock formats; the required proof matrix exercises the ten managers above. JSON CycloneDX (`bom.json`, `*.cdx.json`) and SPDX (`*.spdx.json`) can carry a resolved inventory for the six supported ecosystems.

Manifest scanning is not installed-package attestation. A Maven pom without resolved dependency inventory does not prove complete transitive coverage; resolution is deliberately disabled. Go replacements, private/local/git packages and platform/optional dependency selection may require an environment-generated SBOM. Unresolved requirements and skipped files fail closed. Empty inventories are not accepted as proof of coverage. Input-file hashes are recorded as evidence; package contents and registry signatures are not authenticated by this skill.

## Limits and verification

The proof uses actual scanner parsing and current OSV responses for metadata containing known vulnerable versions. It exercises the real runtime policy and production adapter with a recording executor. It does not install the target vulnerable packages or execute ten different agents. Actual VM stop/NIC removal was separately demonstrated by the LiteLLM live proof.

There is no continuous background monitor, scheduled advisory refresh, isolated package-build service, automatic repair, or unknown-malware behavioral detector in this skill. New advisories are considered on the next preflight or explicit scan. Treat container/VM migration as a separate runtime operation; the host stops quarantined workloads.

The pinned scanner itself runs as a trusted host executable. Its minimal environment excludes provider/CI secrets, but is not a filesystem sandbox. Parser vulnerabilities or a malicious release accepted into the reviewed pin remain host-side risks; the agent VM boundary does not isolate the scanner process.

## Troubleshooting

Check `dependency_scan.status` and findings in the gate JSON. `scan-incomplete` can mean a missing/changed scanner, unsupported/unresolved inventory, parser skip, resource limit or OSV outage. Use a verified scanner and resolved input; do not weaken the host policy to conceal missing coverage. See `REMOVE.md` for rollback.
