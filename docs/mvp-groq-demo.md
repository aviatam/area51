# Groq live demo

This adds a real model proposal and a human approval step to the demo work.
It is a bounded **host-side** demo, not a built-in Groq provider and not yet an
end-to-end model running inside the Incus VM. VM containment and crash/recovery
proof remains in `docs/mvp-live-proof.md`; do not combine those claims.

## Setup and run

1. Set repository Actions secret `GROQ_API_KEY`. Never paste it into chat or inputs.
2. Land this workflow on the default branch after code review. GitHub requires
   default-branch registration for the **Run workflow** UI.
3. In repository Settings → Environments, create `area51-demo`, add `aviatam` as a
   required reviewer. For this owner-operated demo, allow the initiator to review.
   This is a demo environment; it does not deploy the product.
4. Open Actions → **Area51 Groq live demo** → **Run workflow**, enter a request.
5. Read the proposal job summary, including the exact title, source SHA and digest.
6. Use **Review deployments** to approve `area51-demo` with the exact comment
   `approve <proposal SHA-256>` shown in the summary. Reject to prevent execution.
7. The approved job verifies the GitHub review history and routes the exact tool
   call through the production Area51 broker. The summary links the resulting
   neutral GitHub check. No issue, PR, deployment or production action is created.

Without a required reviewer, GitHub may start the environment job automatically;
the code still refuses the write unless an actual owner review with the exact
digest exists. Only `aviatam` may start the execution workflow. Reruns are denied;
start a new run for a new proposal and review.

Branch pushes only run tests and ask Groq for a proposal. They never execute it.
The key is provided only to the proposal step; no secret is put in artifacts.
Prompts are sent to Groq and proposed titles are published in Actions summaries,
so use synthetic demo input. The only tool is a short English-title neutral check
on the tested commit in `aviatam/area51`; the model cannot choose URL, credentials,
repository, commit, HTTP method or approval identity.

## Limits

This is a one-action review flow in GitHub, not a persistent chat application.
The workflow is not an Area51 messaging-channel adapter. The proposal runs on the
host runner. It does not yet demonstrate live model inference inside the VM,
full-host recovery, or durable exactly-once external effects. The duplicate check
and no-rerun rules are bounded demo safeguards, not a replacement for the durable
reservation and recovery controls. Failed/ambiguous writes are never retried.

References: [Groq local tool calling](https://console.groq.com/docs/tool-use/local-tool-calling),
[GitHub workflow review history](https://docs.github.com/en/rest/actions/workflow-runs#get-the-review-history-for-a-workflow-run).
