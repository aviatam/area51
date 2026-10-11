# Historical source and held-startup rollback proof

This hosted test restores exact historical source together with populated host
state, then runs the restored version's actual entrypoint. **The host must refuse
startup at the recovery hold. This is not healthy production reactivation or a
complete GA rollback sign-off.**

The `Historical Rollback Proof` workflow uses a disposable Ubuntu 24.04 runner,
Node 22, and the fixed historical commit
`c3dd1e8f9ceeb0b459d2b324d05a6f66dd884356`. It installs both candidate and historical
dependencies from their respective frozen lockfiles. It archives historical
source, verifies every Git blob and executable bit after extraction, and seeds
synthetic groups, users/roles, sessions, approvals, reservations, inbound pending
messages/tasks, outbound pending messages and provider state through historical
code and schemas.

After snapshot capture, the test loads candidate code against copied populated
state, commits a synthetic change, and injects a migration failure midway through
a transaction. The partial migration must roll back. Restoring the historical
snapshot and source must undo the committed candidate change too, preserve
configuration and session bytes, reopen with historical database code, and pass
integrity/foreign-key checks.

The real historical entrypoint must exit at its restore hold, before central DB
initialization, channel/runtime startup, delivery polls or CLI socket creation.
Restored database, session/configuration bytes and hold files must remain
unchanged by that attempt. Neither hold is deleted or overridden.

The only retained artifact is a sanitized observation report, containing exact
candidate/historical SHAs, source/archive lockfile digests and explicit limits.
Temporary source/state fixtures are removed. No real installation or account is
used, and dependency installation requires package availability: this is not an
air-gapped recovery test.

Run only on the disposable hosted runner, after installing the candidate and an
exact historical checkout with their frozen lockfiles:

```sh
node --import tsx scripts/historical-rollback-proof.ts /absolute/historical-checkout
```

The report deliberately keeps `full_running_historical_host_tested`,
`supported_upgrade_command_tested`, `native_vm_containment_rerun`,
`external_effects_reconciled` and `activation_allowed` false. The test uses
production migration functions with injected synthetic failure, not the complete
supported update command. This historical pair has no real schema migration
between commits; the existing populated migration-boundary proof is separate.

Still required: safe external-state/queue reconciliation, supported-updater failure
testing, approved healthy historical activation, native containment/tool probes
against the running recovered application, a supported-host pilot and release
sign-off. Earlier revisions without a recovery startup gate need their own
explicitly isolated exercise; this workflow does not retrofit a gate into them.
