---
name: dependency-security
description: Add host-side dependency scanning for npm, pnpm, pip, uv, Poetry, Maven, Gradle, Cargo, Go and NuGet, using a pinned OSV-Scanner and Area51 quarantine policy.
---

# Dependency security

Dependency security is built into Area51. Use this skill to verify coverage and diagnose a hold; do not copy or patch core source files.

## Verify automatic operation

Normal host agent startup requires a completed dependency scan without an enable flag or manual installation. On first use the host downloads OSV-Scanner 2.7.0 from its fixed official release URL and verifies the SHA-256 in `src/dependency-security-pins.json`. An optional absolute `AREA51_DEPENDENCY_SCANNER` points to an already provisioned pinned tool. A changed binary, unavailable service, missing inventory or unsupported parser coverage blocks execution.

For a standalone CLI scan or the proof harness, set `AREA51_DEPENDENCY_SECURITY=required`. Diagnostic scans retain their explicit opt-in; live agent enforcement does not depend on this flag.

The host refreshes each running session every 60 seconds, without overlapping scans. A scan can take 90 seconds (plus first tool provisioning). A new finding or incomplete coverage automatically places a persistent host-side session hold, stops Docker execution, or invokes Incus stop, network removal and snapshot quarantine. There is no per-incident approval. Holds prevent automatic restart after a host restart; an operator must review and release them. See `docs/automatic-security-migration.md`.

Run `pnpm exec vitest run src/dependency-security.test.ts src/dependency-monitor.test.ts` and `pnpm exec tsx .claude/skills/dependency-security/prove.ts` with required mode for the ten-manager live proof. Review `.area51/diagnostics/dependency-security/summary.md` and `report.json`.

## Behavior

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

The monitor covers host-visible group inventories, not arbitrary package changes inside a guest. It does not provide an isolated package-build service, automatic repair, unknown-malware detection or live migration. Supply resolved inventories matching the actual runtime, including transitive packages; the host stops held workloads.

The pinned scanner itself runs as a trusted host executable. Its minimal environment excludes provider/CI secrets, but is not a filesystem sandbox. Parser vulnerabilities or a malicious release accepted into the reviewed pin remain host-side risks; the agent VM boundary does not isolate the scanner process.

## Troubleshooting

Check `dependency_scan.status` and findings in the gate JSON. `scan-incomplete` can mean a missing/changed scanner, unsupported/unresolved inventory, parser skip, resource limit or OSV outage. Use a verified scanner and resolved input; do not weaken the host policy to conceal missing coverage. See `REMOVE.md` for rollback.
