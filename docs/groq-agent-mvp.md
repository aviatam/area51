# Area51 agent MVP

This live demo runs the normal `/app/src/index.ts` agent entry with an installed
Groq provider inside a non-root Incus VM. It uses the normal poll loop, persistent
conversation, actual MCP stdio server, production VM DB bridge and host session
action broker. Groq performs remote inference. Real credentials stay on the host.

## Run a live example

1. Open **Actions → Area51 working agent MVP → Run workflow** in this repository.
2. Select `main` and enter a short synthetic question (up to 1,000 characters).
3. Start the workflow once. The owner must start it; there is no second review.
4. Open the completed run's summary for the four-turn conversation, visual
   checklist and link to the actual GitHub check. Download its evidence artifact
   for machine-readable results and the exact tested commit.

The repository needs the existing `GROQ_API_KEY` Actions secret. The temporary
GitHub workflow token has only contents read and checks write. Image construction
does not receive either credential. The model gateway has a fixed upstream,
model, tool schema, bounded context and at most 16 inference requests per run.
Groq free-tier quotas can delay or reject a run; model inference has one bounded
rate-limit retry. External writes are never retried.

The example remembers a fresh random marker, answers your question, restarts the
VM kernel, recalls the marker from the saved conversation, and requests one
neutral GitHub check. The host permits only `groq_mvp_check` with the fixed title
`Area51 MVP live demo`. A peer identity, identity spoof and duplicate are denied.
Starting a fresh workflow creates a fresh session. Do not rerun an uncertain run;
inspect its check and evidence first.

## Reproduce on a Linux KVM host

Install Incus and the repository dependencies. Apply the provider using
`node .claude/skills/groq-mvp/install.mjs`, then build the VM image with
`bash container/incus/build-vm.sh`. The workflow documents the full KVM/network
setup and frozen dependency installation. The live controller intentionally
requires the owner-started GitHub workflow context before using live credentials.
Use the hermetic gateway/provider tests for local development.

## MVP boundary

The workflow provides a self-service live example with a user-supplied question
and a reproducible four-turn transcript. Each run provisions ephemeral VMs;
it is not an always-on chat website. The provider supports queued follow-ups
through the normal session DB and saves history in its session volume. History
is bounded and an uncertain tool outcome stops the session for reconciliation.

The demo controller owns a disposable host reservation database and invokes the
production broker directly. It does not claim a full production daemon/channel
installation, full-host crash recovery, organization SSO, or GA readiness.
The separate containment suite also tests isolation, quarantine and cleanup.
Older recovery evidence must retain its own commit and run attribution.

To remove the provider, follow `.claude/skills/groq-mvp/REMOVE.md` and rebuild.
