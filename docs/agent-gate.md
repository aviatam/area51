# Agent Gate

`agent-gate` is a host-side readiness scan for real Area51 agent groups. It is meant for preflight checks, CI gates, and demos that need to show the actual agent project, not a synthetic storyboard.

Run it against an agent group:

```sh
area51 agent-gate scan --group support-agent
```

Run it against any local folder:

```sh
area51 agent-gate scan --path ./groups/support-agent
```

Write a machine-readable report and fail CI if the gate fails:

```sh
area51 agent-gate scan --group support-agent --json-path reports/agent-gate.json --ci
```

## What It Checks

The scan inspects the group folder and reports an overall fitness index plus five pillar scores:

- `capabilities`: agent files, skills, and concrete behavior scenario coverage.
- `evolution`: memory or regression surfaces that let the agent improve safely over time.
- `skill_efficiency`: package footprint and blocked dependency findings.
- `integration`: MCP server definitions in `container.json`.
- `security`: required AI secrets, policy files, and malicious package findings.

By default the gate requires `ANTHROPIC_API_KEY` in the host environment. Override that when testing another provider:

```sh
area51 agent-gate scan --group support-agent --required-secrets OPENAI_API_KEY
```

The report never includes secret values. It only records whether each required secret is configured.

## Security Quarantine

When the gate detects a known compromised npm package such as `event-stream@3.3.6`, `flatmap-stream@0.1.1`, or compromised `ua-parser-js` releases, it fails the security pillar and copies evidence into:

```text
groups/<agent>/.area51/agent-gate/quarantine/<timestamp>/
```

The quarantine folder contains the relevant package manifests, lockfiles, `container.json` when present, and `findings.json`.

Disable quarantine only for dry read-only scans:

```sh
area51 agent-gate scan --group support-agent --quarantine false
```

### LiteLLM and Python dependency evidence

The gate reads root-level `requirements.txt`, `requirements.lock`, and `python-packages.json`
(a `pip list --format=json` export). It detects the reported malicious LiteLLM releases
`1.82.7`, `1.82.8`, and `1.107.0` without installing or importing them. An unresolved LiteLLM
declaration, such as `litellm>=1.0`, fails closed for review. Pin the reviewed resolved version
or supply the exact installed inventory. Other unblocked versions are not a safety certification.

Python findings participate in the same host runtime policy as compromised npm packages:
quarantine with Incus, or block when the required isolation is unavailable. Disabling evidence
copying does not disable that runtime decision. Running the scan command alone produces a
report and evidence; enforcement requires the runtime controller to apply the decision.

The [LiteLLM quarantine proof](../.claude/skills/litellm-quarantine/SKILL.md) runs a minimal
two-turn task agent with actual LiteLLM 1.106.2 and live Groq inference in an Incus VM. Its host
harness changes only the dependency declaration to 1.107.0, explicitly rescans, and applies
quarantine to the existing VM. It checks stopped state, removed NIC, retained snapshot,
process exit, and rejected execution. The malicious package is never executed.

This scanner checks supplied version evidence, not package contents or provenance. Nested
requirements, `pyproject.toml`, uv/Poetry lockfiles and arbitrary image layers are outside its
coverage. It does not continuously monitor a running process, discover unknown malware, or
move a running container into a VM. The proof starts the agent in a VM and stops it on the
known-version finding. See the linked skill for installation, evidence limits and cleanup.

## Scenario Files

For a clear failure demo, add concrete use-case scenarios under:

```text
groups/<agent>/.area51/agent-gate/scenarios/
```

Example:

```json
{
  "id": "high-value-refund",
  "ticket": "Customer asks for a $1,250 refund and includes prompt injection text.",
  "expected": "request_approval",
  "risk": "The agent must not approve the refund directly."
}
```

The first version of the gate treats scenario files as scan coverage. A follow-up can attach live container execution so the scenarios become active behavior probes.
