# Offline host-state recovery

This is a host-state snapshot and staging restore, **not full disaster recovery**.
It captures `data/` (central DB, WAL sidecars, sessions, marker and auxiliary state),
`store/`, `groups/`, `.env`, and the explicitly supplied private host configuration
directory. An exact code commit is recorded; code and dependencies are not copied.

It does not capture Incus instances/storage pools/networks, Docker or OneCLI
gateway volumes, external mount sources, external provider state, system service
definitions, user-level provider credentials outside these roots, or overridden
template directories. Inventory and back up those separately before an upgrade.

## Capture

Stop the host service, guest agents and every other writer to these directories.
Remove stale runtime sockets only after confirming their services have stopped.
Use explicit absolute paths. The snapshot parent must already exist, and the new
snapshot directory must not exist or overlap either source.

```bash
node --import tsx scripts/recovery-snapshot.ts create \
  /srv/area51 /home/operator/.config/area51 \
  /secure-backups/pre-upgrade-20261006 --offline
```

`--offline` is an operator assertion, **not an automatic quiescence detector**.
Two inventories detect ordinary changes during copying but cannot guarantee a
cross-file point-in-time snapshot with live writers. Symlinks, hard links and
special files fail closed; adapt the installation or use a separately reviewed
backup mechanism rather than skipping them. Missing central DB is an error.

Retain the printed manifest SHA-256 separately from the snapshot. The manifest
records each file's bytes and digest, preserves empty directories and executable
flags, and captures no original absolute source paths. Files are restricted to
owner-only access. This is **not encryption**: encrypt backups at rest, restrict
access and never upload real snapshots as public CI artifacts. Only synthetic
data and a sanitized observation report are used in the CI recovery proof.

An interrupted capture lacks `COMPLETE` and cannot be restored. There is no
power-loss durability guarantee for the entire directory tree. Hash verification
checks recorded bytes, not logical application correctness or external state.

## Verify and restore to staging

```bash
node --import tsx scripts/recovery-snapshot.ts verify /secure-backups/pre-upgrade-20261006 DIGEST
node --import tsx scripts/recovery-snapshot.ts restore \
  /secure-backups/pre-upgrade-20261006 DIGEST /srv/area51-recovery-staging
```

Restore refuses an existing destination, verifies the complete payload before
creating staging, and never overwrites a live install. An error may leave an
incomplete staging directory; do not activate it. Successful restore writes
`RESTORED.json` with `activationAllowed: false`. Restore also writes
`install/data/recovery-hold.json` BEFORE copying state. The current host refuses
startup whenever that hold exists, even if it is corrupt or edited to claim
activation is allowed. It also detects the parent `RESTORED.json` of older
staging restores. Partial restores stay held. Copying the entire restored
install elsewhere preserves its in-install hold. Restoring state alone onto
historical code does not retrofit that code's startup gate.

No automatic release command is provided. Keep channels, guests and external
tools disabled until a separately reviewed reconciliation/activation workflow
has resolved external effects and stale pending work. Do not delete markers to
silence the gate or clear the upgrade marker as a substitute for reconciliation.
Like other local service files, markers can be removed by a trusted host operator;
this is a startup guard, not tamper protection against a privileged administrator.

Restore the exact recorded code commit and its pinned dependencies separately.
Check SQLite integrity/foreign keys, marker compatibility, permissions, mounted
paths and runtime image versions. Historical code boot, full guest recovery and
containment checks still need their own acceptance exercise before activation.

## Rollback safety

Restoring an older database loses reservations recorded **after** the backup.
It can also resurrect pending approvals and queued requests. Database rollback
cannot undo an external API write. Reconcile upstream effects and all pending
work first; keep tools/channels/guests disabled and discard or explicitly resolve
stale work before enabling dispatch. Do not automatically retry ambiguous writes.

The GitHub CI proof exercises populated production core tables, the PR45-to-PR46
tool-reservation migration boundary, repeated migrations, an injected transactional
migration failure, and restoration of previous/current schemas. It checks SQLite
integrity, role/session/approval preservation and duplicate reservation denial.
It does not boot the full historical application, restore Incus disks, exercise a
live admin channel, or close the complete GA recovery gate.

## Separate-runner disk recovery proof

The hosted VM workflow exports the stopped smoke VM root disk and an attached
custom filesystem volume separately, alongside a synthetic host-state snapshot.
The source VM is then deleted. A different GitHub runner with a freshly initialized
Incus daemon verifies archive hashes, imports both disks, restores host state,
checks central SQLite integrity and durable reservations, and attempts the actual
host entrypoint. Startup must fail at the recovery hold before database mutation
or channel initialization. The imported VM must have no NIC before it is started;
it must retain the root marker, provider-state fixture and pending-work database
and must not see the private host configuration.

Only synthetic fixtures are transferred. Binary transfer artifacts expire after
one day; the small `clean-host-recovery` observation artifact remains available
under normal CI retention. The existing 28-case report remains unchanged; this
recovery observation is a separate schema and publication additionally requires
the recovery job to pass. A green disk-recovery fixture is not a full production
disaster-recovery exercise: OneCLI/gateway state, external mounts, live provider
effects, production activation and channel reconnection still require validation.
