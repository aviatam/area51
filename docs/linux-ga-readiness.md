# Linux GA release gates

The [offline host-state recovery utility](host-state-recovery.md) adds verified
snapshots and non-overwriting staging restore. Its CI proof covers a populated
SQLite migration boundary and previous/current schema recovery. This is partial
recovery evidence. The separate-runner VM proof adds root/custom-disk transfer
and enforced startup hold checks, but external state, historical code boot and
safe live activation remain outside that fixture. The complete recovery gate
remains open until those end-to-end requirements are verified.

Area51 is not declared GA by passing its containment suite. GA requires a
reviewed release candidate and the gates below. Each result must identify the
candidate commit, configuration, test date, upstream observations where relevant,
and a reproducible command or retained report. A fixture result cannot substitute
for a live account, tenant, or physical-host result.

## First release scope

The first GA certification target is **Ubuntu 24.04 LTS on x86-64 with KVM
and Incus VM isolation**, as bounded by the [GA acceptance contract](linux-ga-acceptance.md).
This is the scope to validate, not a statement that certification is complete.
The installer accepts Ubuntu 22.04/24.04 and Debian 12/13, but those other
distributions remain experimental until separately certified. Acceptance on one
GitHub runner does not certify that entire matrix.
ARM64, Windows and macOS deployment remain outside the first GA claim. Host unit
tests on those operating systems are separate evidence.

The first production tool adapter supports named POST actions and argument-free GETs at fixed endpoints,
flat string/number/boolean arguments, host-held bearer credentials, per-group
permissions and administrator approval. It acknowledges HTTP success; it does not
return business response data. General MCP proxying, arbitrary APIs and enterprise
SSO runtime authorization are not included in that adapter's claim.

## Required evidence

| Gate                      | Existing evidence                                                                                                                                                | Remaining pass condition                                                                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installer and containment | Merged `f9b7c12015e3d8530db026c91f38e00cb4e04544`: [hosted run](https://github.com/aviatam/area51/actions/runs/37186795701), 3 suites / 28 cases                 | Repeat against the final candidate; verify every distribution advertised as supported                                                                                                                                            |
| Production tool path      | Session-bound broker integration and credentialed local HTTP tests                                                                                               | Candidate CI must pass host registry and container tool tests; exercise the same session path in a live VM                                                                                                                       |
| Real business API         | Synthetic credentialed upstream only                                                                                                                             | Require the GitHub probe to pass on the candidate; complete a combined guest/session/admin-channel live deployment and direct/alternate route denial. Additional services need their own designated test accounts and audit logs |
| Administrator access      | Existing channel identities/roles and live role checks; enterprise registry enrollment fixtures                                                                  | Verify signed-in administrators and removal of privileges in the actual channel; use Entra/Okta test tenants if enterprise SSO is advertised                                                                                     |
| Upgrade and rollback      | Supported update flow creates code rollback points; startup upgrade tripwire                                                                                     | Upgrade a populated previous install, preserve session data/configuration, fail midway, restore code AND database, then run containment and tool checks                                                                          |
| Backup and restore        | Offline host-state verification, reconciliation fixtures and separate-runner VM/root/custom-volume restoration with startup hold; no complete live restore proof | Restore central DB, session DBs/workspaces, provider state, private host config and required runtime assets on a clean host; verify permissions and integrity; invalidate outstanding approvals                                  |
| Host failure/reboot       | Same-VM reboot/disk persistence and bounded stopped-VM recovery                                                                                                  | Kill host process during a pending/dispatching action, reboot the Linux host, prove no automatic duplicate external write; recover all sessions and rerun isolation probes                                                       |
| Independent review        | In-repository adversarial tests                                                                                                                                  | Independent reviewer assesses VM/host boundary, mount policy, approvals, credentials, alternate tool routes and dependency risks; material findings resolved and retested                                                        |
| Pilot and release         | Protected release workflow and pinned evidence machinery                                                                                                         | Successful pilot on supported Linux hardware, tested recovery runbook, support/patch policy, signed-off candidate and release notes with exact limitations                                                                       |

Pending gates remain pending. Do not turn them green using a narrative assertion
or reuse an older passing commit after changing the enforcement code.

## Live validation access

Prepare a disposable business-service account and a dedicated resource containing
no customer data. Supply its fixed action endpoint and a least-privilege test
credential through the private host configuration, plus read access to its audit
log. The account must permit one harmless reversible write so the test can prove
an approved action reached the service. Do not send credentials in a PR, issue,
chat transcript, or CI log. Approved test-account work must specify the resource
and allowed mutation before dispatching it.

For enterprise claims, prepare an Entra or Okta test application/tenant with one
assigned administrator and one unassigned user, then remove the assigned user's
access and observe denial. Existing device-login/enrollment tests use a local
provider fixture; registry enrollment does not establish runtime authorization.

The hardware pilot needs a Linux host with working KVM, sufficient resources for
two concurrent agent VMs, and an operator able to reboot it and inspect the
recovered services. Choose the independent reviewer separately from the people
implementing the controls.

## Release decision

Keep this candidate in beta until every gate within the published scope passes.
A Linux-only release does not require Windows/macOS deployment. A release that
omits enterprise SSO must say so and still prove its supported administrator
authentication and revocation path. Publish through the protected Release
workflow only after reviewing evidence and approving the exact candidate.
