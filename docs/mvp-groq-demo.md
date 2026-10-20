# Groq live demo

The owner starts a manual workflow with a request. Groq proposes a short title;
the next job automatically creates one neutral GitHub check through the Area51
broker. There is no additional approval, environment review or digest to copy.

This is a bounded **host-side** demo, not a built-in Groq provider or inference
inside an Incus VM. VM containment and crash/recovery proofs are separate.

## Setup and run

1. Set repository Actions secret `GROQ_API_KEY`. Never paste it into chat or inputs.
2. Open Actions → **Area51 Groq live demo** → **Run workflow** on `main`.
3. Enter a synthetic demo request and click **Run workflow** as `aviatam`.
4. Wait for `proposal` and `execute-action` to finish. The execution job summary
   links the resulting neutral GitHub check.

Starting the workflow authorizes this single bounded demo action. The previous
`area51-demo` environment is no longer referenced; it can remain configured.
Already-started runs use the workflow version they started with: cancel an old
waiting run and start a fresh run after this change lands. Reruns are denied.

Only an initial `workflow_dispatch` started and triggered by `aviatam` executes.
The proposal must match the trusted runner's repository, source commit and run.
The host policy allows only `create_neutral_check` for the demo agent. Production
approval policies and the broker's approval support are unchanged.

Branch pushes only run tests and ask Groq for a proposal. They never execute it.
The key is provided only to the proposal step; no secret is put in artifacts.
Prompts are sent to Groq and proposed titles are published in Actions summaries,
so use synthetic demo input. The only tool is a short English-title neutral check
on the tested commit in `aviatam/area51`; the model cannot choose URL, credentials,
repository, commit, HTTP method or runner identity.

## Limits

This is a one-action workflow in GitHub, not a persistent chat application.
The workflow is not an Area51 messaging-channel adapter. The proposal runs on the
host runner. It does not demonstrate human approval or live model inference inside the VM,
full-host recovery, or durable exactly-once external effects. The duplicate check
and no-rerun rules are bounded demo safeguards, not a replacement for the durable
reservation and recovery controls. Failed/ambiguous writes are never retried.

Reference: [Groq local tool calling](https://console.groq.com/docs/tool-use/local-tool-calling).
