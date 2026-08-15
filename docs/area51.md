# Area51

Area51 is the Area51 control plane combined with an Incus runtime/security layer. Area51 keeps the agent group, memory, messaging, scheduled jobs, and Agent Gate model. Incus becomes the target substrate for project isolation, profiles, snapshots, freeze/stop, and quarantine evidence.

Run the local demo:

```sh
area51 demo --output-dir .area51/demo
```

The demo writes:

```text
.area51/demo/reports/agent-gate.json
.area51/demo/reports/runtime-policy.json
.area51/demo/reports/incus-runtime-plan.json
.area51/demo/reports/area51-demo.json
```

## Demo Flow

The generated support-refund agent includes:

- a real `CLAUDE.md` agent instruction file
- a high-value refund approval policy
- a concrete prompt-injection refund scenario
- MCP entries for CRM and payments
- a deliberately blocked npm package, `event-stream@3.3.6`

Agent Gate scans the group, fails closed on the compromised package, writes quarantine evidence, and scores all five pillars. Runtime Policy then turns that gate output plus host-owned production posture, trust level, data sensitivity, and requested capabilities into a decision. The demo proves the compromised package path becomes `quarantine` through an Incus container instead of silently falling back to a weaker runtime.

The Incus plan maps that same group to:

- `area51-<group>` Incus project
- per-agent instance
- workspace and session mounts
- non-privileged runtime restrictions
- network profile plus a quarantine profile
- freeze, snapshot, network-detach, and quarantine-label commands

The demo is intentionally runnable on machines without an Incus daemon. It verifies that Area51 can produce the exact Incus operations, the real Agent Gate artifacts, and a deterministic runtime policy decision. On a Linux host with Incus installed, the `incus-runtime-plan.json` commands are the implementation path for a live runner.

## Runtime Policy

Runtime Policy is host-owned. Agents can request work, but they do not choose Docker, Incus, VM isolation, or quarantine for themselves.

Policy inputs:

- Agent Gate pass/fail, findings, missing secrets, and quarantine evidence
- admin profile: `local`, `production`, or `maximum`
- trust level: built-in, approved, third-party, or unknown
- data sensitivity: low, business, customer, or secret
- requested capability level: chat, files, network, browser, shell, package install, broad mounts, or secret access
- Incus availability and whether Docker fallback is allowed

Policy outputs:

- `allow` on `docker` for trusted low-risk local work
- `allow` on `incus-container` for production work that needs stronger isolation
- `allow` on `incus-vm` for maximum isolation
- `quarantine` for compromised package evidence when Incus is available
- `block` when policy requires Incus but Incus is unavailable

## Commercial Licensing

Area51 is MIT licensed. Incus is Apache-2.0 licensed. Both are permissive and generally compatible with commercial use, including modification and redistribution.

Do not remove required license notices from copied source. Keep the MIT and Apache-2.0 notices with redistributed code, preserve copyright notices, and track any direct Incus code copied into Area51. The cleanest commercial route is to shell out to the Incus CLI or call its API from Area51 instead of vendoring large Incus source files.
