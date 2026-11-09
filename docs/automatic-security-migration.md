# Automatic dependency security and standalone sources

Normal Area51 agent startup now requires dependency coverage. The feature is native: no skill application, enable flag, scanner-path configuration or per-incident approval is needed. The host downloads and verifies the pinned OSV-Scanner on first use. `AREA51_DEPENDENCY_SCANNER`, if supplied in the host process environment, must reference an already provisioned matching binary. Diagnostic-only CLI scans retain the explicit `AREA51_DEPENDENCY_SECURITY=required` opt-in.

## Before upgrading an existing installation

Stop the host and preserve its data and configuration. Supply resolved lockfiles or a resolved CycloneDX/SPDX JSON SBOM in each `groups/<folder>/` tree, matching the actual workload and its transitive dependencies. A group with no supported inventory is blocked; a manifest is not proof of what is installed in a VM. Do not use an unrelated clean inventory to unblock a runtime. Inventory generation and package installation are not automated by this change.

### Import a reviewed inventory before the first agent starts

With the Area51 host stopped, export a resolved lockfile/SBOM from the actual trusted image build or workload environment, review its coverage and embedded credentials, and record the immutable image digest. Remove secrets from the reviewed import copy before putting it in an agent-readable group; the importer does not redact file content. Prefer a resolved SBOM covering all applicable package roots and transitive dependencies. Do not substitute the host project's lockfile or an unrelated clean package to make the gate pass.

Run the host-only import command from the checkout. Both file paths must be absolute; the group directory must already exist. Replace the digest below with the image's actual SHA-256:

```bash
node --import tsx scripts/dependency-inventory.ts \
  --source /absolute/reviewed-image-inventory/bom.cdx.json \
  --group-dir /absolute/area51/groups/first-agent \
  --runtime-id first-agent \
  --image-id sha256:ACTUAL_64_CHARACTER_HEXADECIMAL_DIGEST \
  --reviewed
```

The command copies the exact source bytes into `dependency-inventory/` under the selected group. A private audit record with SHA-256, import time, filename and operator-provided runtime/image labels is kept outside the group under `data/dependency-inventory-imports/` relative to the checkout. Use `--record-dir /absolute/private/host-records` to select another host-only location; it must remain outside the group and all guest mounts. It rejects missing/empty/oversized files, leaf symlinks, unsupported filenames, malformed JSON and unresolved requirements. Other lockfile syntax and complete package identities are validated by the subsequent mandatory scanner, not by this import. Import success does not mean that the inventory is clean or complete.

This is a practical **operator-reviewed bootstrap snapshot**, not installed-runtime collection or attestation. The command never invokes Docker/Incus, a package manager, a model or an agent. Its runtime/image labels are assertions and are not enforced as image binding by the runtime. Run only with trusted operator paths and the host stopped; it is not an adversarial ancestor-directory race defense. Inspect and protect the inventory from guest modification. If the image, environment or dependencies change, regenerate and review the inventory before use; this command does not detect in-guest changes. A failed publication may leave its private audit record, but does not start an agent or release a hold.

After import, run the required gate scan before starting the host:

```bash
AREA51_DEPENDENCY_SECURITY=required area51 agent-gate scan \
  --path /absolute/area51/groups/first-agent \
  --json-path /absolute/area51/reports/first-agent-gate.json --ci
```

Require completed dependency coverage and review all findings. The normal agent wake will scan again. A known advisory, parser failure or incomplete inventory still blocks; importing never releases an existing hold. To replace a snapshot, first preserve and move the entire existing `dependency-inventory/` directory outside every scanned group tree, then import the new reviewed file. The command refuses to overwrite existing evidence. For rollback, stop the host and remove only the imported directory after preserving it; without a replacement inventory, execution remains blocked.

Allow the host to reach the fixed GitHub OSV-Scanner release download and the OSV service. Package identities and versions are disclosed to OSV; model and GitHub credentials are not passed to the scanner. An outage, altered scanner, invalid or unresolved inventory is unknown coverage and blocks startup.

## Automatic runtime behavior

The normal runner scans before spawning an agent. Each running session is rescanned every 60 seconds, even when inventory files do not change, so fresh advisories can be detected. There is at most one scan in flight per session. Scans can take 90 seconds; initial tool download can take another 30 seconds. Detection is periodic, not instantaneous. The source is the host-visible group tree; changes confined to a guest, external mounts, OS packages and dependencies omitted from the supplied inventory are not attested.

A finding or incomplete scan writes a host-owned hold in `data/dependency-holds/<session-hash>.json`. The hold survives host restart and prevents automatic wake. Incus freezes, stops, isolates and verifies containment before taking its evidence snapshot, and preserves the instance from normal cleanup. Docker is stopped and restart is blocked; Docker does not receive an Incus snapshot or migrate into a VM. Failures are logged and an Incus quarantine error also attempts a forced stop. No containment API can guarantee success when its daemon is unavailable; inspect host errors.

All active vulnerability advisories trigger the conservative policy, regardless of severity. They do not prove compromise. Unknown malware and automatic package repair remain outside this feature.

## Detect, remediate, verify, release

1. Inspect the session hold, `dependency_scan.status`, scanner findings and host logs. Preserve linked temporary evidence before host temporary cleanup and retain Incus snapshots.
2. Review the advisory or coverage failure. Rebuild affected runtimes from reviewed dependencies and export a matching resolved inventory; restore service connectivity or the pinned scanner when appropriate.
3. With the host stopped, run a required diagnostic gate scan against the affected group and verify completed coverage with no dependency findings. Use the project's normal gate CLI or `scanAgentGate({groupDir, dependencySecurity: 'required'})`. Inspect other gate findings as well.
4. An operator may then archive and remove only the reviewed session's hold file. Restart the host to clear its in-memory hold. The next wake performs another mandatory scan. This does not restart or release the old quarantined Incus instance; preserve or clean it through the existing operator procedure.

## Rollback

Stop the host, retain holds and evidence, and restore a reviewed previous release with its matching configuration. The former skill's `install.mjs --remove` refuses to disable native enforcement. No package-manager release-age, build whitelist or dependency installation rules are relaxed.

## Standalone ownership

Setup no longer sends inherited external analytics. Update/migration source instructions validate the Area51 repository before fetching executable instructions. Channel remote discovery recognizes only the exact `aviatam/area51` URL by default and preserves unrelated remotes. It does not add or substitute a remote automatically. Explicit `AREA51_CHANNELS_REMOTE` names an existing trusted remote; the requested registry branch must be readable before installation. See [registry sources](registry-sources.md). NanoClaw is not an operational service or update source. Existing MIT copyright and license notices remain.

GitHub reported `fork:false` for `aviatam/area51` during the 2026-11-09 review. Optional first-party channel/provider branches remain unpublished; missing branches fail rather than falling back to NanoClaw. The built-in local CLI channel does not require those optional registries.
