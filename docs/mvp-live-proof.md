# Bounded MVP live proof on GitHub machines

This branch exercises real KVM/Incus VMs and a harmless GitHub API mutation on disposable Actions runners. It is not a customer deployment, signed-in administrator channel, LLM quality test, full host crash/reboot or GA sign-off.

## Repeatable examples

The `Incus VM Image Smoke` workflow runs on pushes to `test/mvp-live-*`. The exact `test/mvp-live-proof` branch additionally enables the real API example. Its VM job receives a temporary repository-scoped `checks:write` credential only during the live containment step. The token is never passed to the guest or dispatch worker. No customer data or existing business records are changed.

1. **Isolation and quarantine:** the existing three fresh two-VM trials exercise guest MCP tools, private mounts, network denial, session isolation, runtime escalation and stopped-instance quarantine. The installer, same-VM reboot and separate-runner recovery exercises remain enabled with their existing limitations.
2. **Real action and approval enforcement:** each primary/peer guest submits a new MCP request through the production VM outbox bridge. The peer and identity override are denied. The primary action stays pending with zero upstream writes; agent and wrong-session approval attempts fail. A named host-fixture administrator approves the exact request. The only permitted mutation is creation of one completed **neutral check run** on the tested commit, with a unique `area51-mvp-` name.
3. **Accepted-but-unknown crash:** a test proxy forwards the approved request to GitHub, waits for HTTP 201, and withholds the response. The controller kills a dedicated production-session-broker worker with SIGKILL. It verifies the worker never received the result, restores an earlier snapshot with zero reservations, imports the surviving request IDs and prepares the held restore. Redelivery at the broker seam is denied. A direct upstream read verifies exactly one check run still exists. The recovery hold is never removed.

Each VM trial retains `mvp-live-github-trial-N.json` in the VM diagnostics artifact, including tested commit, time, guest/bridge evidence, correlated upstream check URL, worker crash facts, import count, no-duplicate observation and explicit false flags. Neutral probe checks are intentionally retained as public evidence (three per successful run); they do not determine product acceptance.

## What passing means

A pass demonstrates live VM-originated tool requests, real external API writes after a fixture approval, and duplicate suppression across an actual dispatch-worker crash and snapshot rollback. It does **not** demonstrate a full deployed Area51 host restarting, physical-host reboot, a real human approval through a deployed channel, automatic upstream reconciliation, customer payment/order idempotency or safe activation. The outbox replay is submitted directly to the service seam while the installation remains held. The agent workload is deterministic test code, not a live model.

The local controller regression simulates VM outboxes and the GitHub API, but uses a real child process, SIGKILL and SQLite restore/import. It checks both successful recovery and refusal when upstream acceptance fails. It is not counted as live VM/API evidence.

No GA gate is closed by this document. Review all retained reports for the exact candidate, not just a green workflow badge. The separate recovery-reservation branch is included in this test branch and still requires review/merge. Actual pilot access and independent security review remain separate requirements.
