# Groq-backed guest proof

This extends the live VM containment proof with one real model-backed action per
trial. A non-root Bun driver inside the isolated VM calls the primary host relay,
receives a real Groq local-tool proposal, and submits its proposed title using
the production MCP `tool_action` handler. The production VM database bridge copies
the outbox to the host. The host session broker binds it to the trusted session
and allows one fixed neutral GitHub check, without a human approval step.

Only the host holds `GROQ_API_KEY` and the temporary `checks:write` GitHub token.
The VM receives an ephemeral one-use relay credential for a fixed prompt and
model operation. It cannot choose an upstream URL, API credential, repository,
commit, status or conclusion. The gateway rejects wrong tokens, extra fields and
repeat requests, and returns no provider error body. The peer VM's request is
denied. Spoofed identity and outbox redelivery cannot add another upstream write.

The dedicated `Groq agent inside Incus VM proof` workflow builds the real VM image
on a disposable Ubuntu/KVM runner, performs three fresh two-VM containment trials
and validates all three evidence reports against the exact commit. Its branch
push is deliberately restricted to `test/groq-vm-proof`; PRs run host tests without
live credentials. Owner-started dispatches may supply a synthetic prompt after
default-branch workflow registration. Evidence is uploaded as `groq-vm-evidence-*`.

The trial ledger is a disposable SQLite reservation fixture using the production
session broker's reserve port; this test does not exercise crash/restore. Each
trial refuses existing upstream records and never retries ambiguous writes.

Inference takes place remotely at Groq, not inside the VM. The VM contains the
bounded orchestration driver, not an installed full agent provider or persistent
chat loop. This proves the combined VM → model gateway → MCP → DB bridge → host
broker → GitHub path. It does not prove human approval, complete provider install,
full-host recovery, automatic external reconciliation or production activation.
