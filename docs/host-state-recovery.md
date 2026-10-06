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
`RESTORED.json` with `activationAllowed: false`. That flag is informational;
the current host does not enforce it. Staging must remain disconnected from
channels, guests and external tools until an operator completes reconciliation.

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
