# First Linux GA acceptance contract

Status: **pre-GA; release blocked**. Scope and evidence rules are frozen for the
first certification attempt. A reviewed change is required to broaden them.
Passing CI is necessary, not sufficient. See [readiness](linux-ga-readiness.md)
for the remaining work and [host recovery](host-state-recovery.md) for current limits.

## Bounded release claim

| Dimension            | First GA certification target                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host                 | Ubuntu 24.04 LTS, x86-64, working hardware KVM; operator-controlled host reboot                                                                             |
| Isolation            | Incus VM backend; Incus 7.0 LTS package channel used by the VM CI proof; record exact installed versions and image fingerprint                              |
| Host runtime         | Node.js 22 and the repository-pinned pnpm; record exact Node, pnpm, guest Bun and dependency-lock versions                                                  |
| Installation         | Documented installer and service on a fresh supported host; record source commit and installer options                                                      |
| Agent execution      | Session-bound VM path; private host credentials/configuration never mounted into the guest                                                                  |
| External actions     | Named fixed-endpoint POST actions and argument-free GETs, flat scalar arguments, host-held bearer credentials, group permissions and administrator approval |
| Administrator access | One named deployed channel/configuration, with identity, role and revocation tests; channel selection must be retained in the candidate evidence            |
| Recovery             | Stopped-writer snapshot, verified restore to an empty destination, approval invalidation, external-state reconciliation and explicit safe reactivation      |

This contract does not claim Ubuntu 22.04, Debian, ARM64, Windows/macOS runtime,
containers as an equivalent VM boundary, arbitrary MCP/API proxying, returned
business response data, or Entra/Okta runtime SSO. Existing installer branches or
cross-OS host unit tests do not extend this support statement. Additional
channels/services need separate evidence; a GitHub API probe alone does not
certify a combined guest/admin-channel production path. Physical-host evidence
must identify hardware or a dedicated host with operator-controlled reboot;
hosted CI runner identity is not physical-host attestation.

## Release gates

All gates are mandatory. Missing, skipped, fixture-only or inconclusive evidence
is **not passed**. No date is committed until the gate owner reviews the evidence.

| ID    | Pass condition                                                                                                                                                                                                                                                                          | Required evidence class                                                         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| GA-01 | Fresh installation and service start; native VM containment and credential/mount/network denial cases pass on the exact candidate                                                                                                                                                       | Candidate CI plus supported-host pilot                                          |
| GA-02 | Real VM/session request receives administrator approval, performs one authorized reversible API action, and produces correlated upstream audit evidence; unapproved/direct/alternate routes, revoked roles, expired and replayed approvals are denied without upstream writes           | Combined deployed path, designated channel and disposable API resource          |
| GA-03 | Upgrade a populated previous installation; inject failure midway; restore matching historical code AND compatible databases/config/session assets; start that restored version and rerun containment and tool checks                                                                    | Retained old/new commit and schema evidence, failure injection and boot reports |
| GA-04 | Restore host/session/provider state and VM root/custom disks on a clean host; verify integrity/permissions, invalidate outstanding approvals, keep dispatch held, reconcile pending/dispatching and post-snapshot upstream effects, then explicitly reactivate without duplicate writes | Clean-host recovery plus real upstream audit and activation reports             |
| GA-05 | Kill host process during an action, reboot the supported host, recover sessions and rerun isolation probes; ambiguous external results stay held until resolved and no automatic duplicate external write occurs                                                                        | Operator-controlled host failure/reboot pilot and upstream audit                |
| GA-06 | Independent review covers VM/host boundary, mounts, approvals, credentials, alternate routes and dependencies; all material findings resolved and retested                                                                                                                              | Reviewer identity, dated findings and closure evidence                          |
| GA-07 | Pilot passes, recovery runbook is rehearsed, support/patch policy and limitations are published, exact candidate is approved and protected release verification passes                                                                                                                  | Operator/reviewer/release-owner sign-offs and retained release verification     |

Recovery must not treat an absent response as proof that an external action did
not happen. Unknown outcomes remain blocked; retry requires authoritative
upstream reconciliation or a demonstrated service-specific idempotency mechanism.
Never remove a recovery hold merely to make a test green.

## Evidence record and invalidation

For each gate retain: ID, pass/fail/blocked result, full candidate SHA, old SHA
where applicable, UTC test time, operator/reviewer, host OS/kernel/architecture,
KVM and Incus versions, image fingerprint, runtime/lockfile versions, sanitized
configuration identity, command, workflow/job URL or report location, report
digest, observations and limitations. Live-action reports must also correlate
session/request/approval IDs with upstream audit IDs and before/after state.
Keep credentials, private configuration and customer snapshots out of public
artifacts. Retain restricted evidence separately and link only sanitized reports.

Changing candidate code, dependencies, images or enforcement configuration makes
the prior candidate's passing results historical. Re-run candidate checks and
all affected live gates; final sign-off must identify the same candidate as the
release workflow. A documentation-only change still needs candidate CI and an
explicit review of whether the published claim changed.

## Current checkpoint, not GA sign-off

On 2026-10-10, merged PR #50 produced candidate
`c3dd1e8f9ceeb0b459d2b324d05a6f66dd884356`. Its four push workflows passed:

- [CI](https://github.com/aviatam/area51/actions/runs/38065033150)
- [Cross-OS host tests](https://github.com/aviatam/area51/actions/runs/38065033162)
- [Incus live E2E](https://github.com/aviatam/area51/actions/runs/38065033149)
- [Incus VM image smoke/recovery](https://github.com/aviatam/area51/actions/runs/38065033147)

This records workflow status only, not independent inspection of every main-run
artifact. The reviewed PR-head recovery fixture proves a synthetic recovery
milestone; it does not close GA-02 through GA-07. No complete GA gate is declared
passed by this checkpoint.

## Next implementation and access prerequisites

Next engineering task: close GA-03/GA-04 with historical code boot, external-action
reconciliation and a separately evidenced safe reactivation path. Keep real
dispatch disabled until the designated test mutation is explicitly authorized.

Before live gates: select a supported Linux KVM host and reboot operator, one
administrator channel, one disposable API resource with audit access and a
harmless reversible action, and an independent security reviewer. Those choices
and permissions are prerequisites, not supplied by CI. Publishing GA requires
separate approval of the final release candidate; this contract does not grant it.
