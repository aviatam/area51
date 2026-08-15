# Area51

Area51 is the NanoClaw control plane combined with an Incus runtime/security layer. NanoClaw keeps the agent group, memory, messaging, scheduled jobs, and Agent Gate model. Incus becomes the target substrate for project isolation, profiles, snapshots, freeze/stop, and quarantine evidence.

Run the local demo:

```sh
area51 demo --output-dir .area51/demo
```

The demo writes:

```text
.area51/demo/reports/agent-gate.json
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

Agent Gate scans the group, fails closed on the compromised package, writes quarantine evidence, and scores all five pillars. The Incus plan maps that same group to:

- `area51-<group>` Incus project
- per-agent instance
- workspace and session mounts
- non-privileged runtime restrictions
- network profile plus a quarantine profile
- freeze, snapshot, network-detach, and quarantine-label commands

The demo is intentionally runnable on machines without an Incus daemon. It verifies that Area51 can produce the exact Incus operations and the real Agent Gate artifacts. On a Linux host with Incus installed, the `incus-runtime-plan.json` commands are the implementation path for a live runner.

## Commercial Licensing

NanoClaw is MIT licensed. Incus is Apache-2.0 licensed. Both are permissive and generally compatible with commercial use, including modification and redistribution.

Do not remove upstream license notices from copied source. Keep the MIT and Apache-2.0 notices with redistributed code, preserve copyright notices, and track any direct Incus code copied into this fork. The cleanest commercial route is to shell out to the Incus CLI or call its API from Area51 instead of vendoring large Incus source files.
