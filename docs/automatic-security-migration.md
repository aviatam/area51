# Automatic dependency security and standalone sources

Normal Area51 agent startup now requires dependency coverage. The feature is native: no skill application, enable flag, scanner-path configuration or per-incident approval is needed. The host downloads and verifies the pinned OSV-Scanner on first use. `AREA51_DEPENDENCY_SCANNER`, if supplied in the host process environment, must reference an already provisioned matching binary. Diagnostic-only CLI scans retain the explicit `AREA51_DEPENDENCY_SECURITY=required` opt-in.

## Before upgrading an existing installation

Stop the host and preserve its data and configuration. Supply resolved lockfiles or a resolved CycloneDX/SPDX JSON SBOM in each `groups/<folder>/` tree, matching the actual workload and its transitive dependencies. A group with no supported inventory is blocked; a manifest is not proof of what is installed in a VM. Do not use an unrelated clean inventory to unblock a runtime. Inventory generation and package installation are not automated by this change.

Allow the host to reach the fixed GitHub OSV-Scanner release download and the OSV service. Package identities and versions are disclosed to OSV; model and GitHub credentials are not passed to the scanner. An outage, altered scanner, invalid or unresolved inventory is unknown coverage and blocks startup.

## Automatic runtime behavior

The normal runner scans before spawning an agent. Each running session is rescanned every 60 seconds, even when inventory files do not change, so fresh advisories can be detected. There is at most one scan in flight per session. Scans can take 90 seconds; initial tool download can take another 30 seconds. Detection is periodic, not instantaneous. The source is the host-visible group tree; changes confined to a guest, external mounts, OS packages and dependencies omitted from the supplied inventory are not attested.

A finding or incomplete scan writes a host-owned hold in `data/dependency-holds/<session-hash>.json`. The hold survives host restart and prevents automatic wake. Incus runs the existing freeze/snapshot/stop/network-removal quarantine sequence and preserves the instance from normal cleanup. Docker is stopped and restart is blocked; Docker does not receive an Incus snapshot or migrate into a VM. Failures are logged and an Incus quarantine error also attempts a forced stop. No containment API can guarantee success when its daemon is unavailable; inspect host errors.

All active vulnerability advisories trigger the conservative policy, regardless of severity. They do not prove compromise. Unknown malware and automatic package repair remain outside this feature.

## Detect, remediate, verify, release

1. Inspect the session hold, `dependency_scan.status`, scanner findings and host logs. Preserve linked temporary evidence before host temporary cleanup and retain Incus snapshots.
2. Review the advisory or coverage failure. Rebuild affected runtimes from reviewed dependencies and export a matching resolved inventory; restore service connectivity or the pinned scanner when appropriate.
3. With the host stopped, run a required diagnostic gate scan against the affected group and verify completed coverage with no dependency findings. Use the project's normal gate CLI or `scanAgentGate({groupDir, dependencySecurity: 'required'})`. Inspect other gate findings as well.
4. An operator may then archive and remove only the reviewed session's hold file. Restart the host to clear its in-memory hold. The next wake performs another mandatory scan. This does not restart or release the old quarantined Incus instance; preserve or clean it through the existing operator procedure.

## Rollback

Stop the host, retain holds and evidence, and restore a reviewed previous release with its matching configuration. The former skill's `install.mjs --remove` refuses to disable native enforcement. No package-manager release-age, build whitelist or dependency installation rules are relaxed.

## Standalone ownership

Setup no longer sends inherited external analytics. Update/migration source instructions validate the Area51 repository before fetching executable instructions. Channel remote discovery recognizes only the exact `aviatam/area51` URL by default; it preserves unrelated `upstream` remotes and creates `area51-source` when needed. Explicit `AREA51_CHANNELS_REMOTE` remains an operator override. NanoClaw is not an operational service or update source. Existing MIT copyright and license notices remain.

The GitHub fork-network relationship is separate. Do not delete and recreate the repository or leave its fork network without reviewing GitHub's metadata-loss warning and preserving the required issues, PRs and settings. Code independence does not assert that GitHub has already detached the fork. Optional channel/provider branches must be published and maintained in Area51's own repository; missing branches fail rather than falling back to NanoClaw.
