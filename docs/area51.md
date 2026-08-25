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

The Incus adapter applies the same plan with argv-based CLI calls. It never runs generated shell strings, and its executor is injectable so tests can prove every command without needing a privileged Incus daemon in GitHub's shared runners.

Live agent execution can opt into the Incus backend with:

```bash
AREA51_RUNTIME_BACKEND=incus
AREA51_INCUS_IMAGE=local:area51-agent-v2
AREA51_INCUS_INSTANCE_KIND=vm   # optional: container by default, vm for high-risk work
```

Build the required runtime image first with `bash container/incus/build.sh`.
Area51 does not fall back to a stock distribution image: a bootable Debian or
Ubuntu guest does not contain Bun, the agent-runner dependencies, or the pinned
provider CLI. Every spawn verifies Bun and `/app/node_modules`; an incompatible
guest is stopped and the session fails closed.

Before either Docker or Incus is created, the host provisions the OneCLI route,
runs Agent Gate once, and passes its report plus stored package/mount
capabilities to live Runtime Policy. The decision is persisted outside agent
mounts at `data/runtime-policy/<session-id>.json` with mode `0600`. Docker is
allowed only when policy explicitly selects it; risky local work blocks when
Incus is unavailable, and production policy can escalate a configured Incus
container posture to a VM. The runtime plan must match the selected kind or
startup fails closed.

Incus containers do not receive a general-purpose NIC. OneCLI credentials,
certificates, and proxy variables are fetched per agent and exposed through a
guest-loopback proxy relay. If that configuration is unavailable, Area51 does
not start the agent. VM execution attaches its required NIC only through the
audited deny-by-default ACL.

In that mode the host builds the normal Area51 session/group/runner/skill mount
set, applies an Incus runtime plan, and starts the runner with `incus exec`.
Docker remains the default backend for local development and cross-platform
compatibility.

The live Incus path hardens that mount set before it reaches Incus. Only
`/workspace` and Claude's exact `/home/node/.claude` provider-state path stay
writable; VM mode backs both with isolated managed volumes rather than live host
bind mounts. Agent definitions, shared runtime source, skills, other provider
paths, and plugin content are read-only. Before controlled VM deletion, bounded
regular provider files are staged by root, path/size/digest validated by the
host, and atomically installed for the next VM. The adapter also fails closed
if a plan tries to mount host roots, home-directory roots, SSH/cloud config
directories, Docker/Podman sockets, or Incus/LXD sockets.

## Exposure Command

The demo is intentionally fixed so it can prove the same behavior every time. Real work enters through `area51 expose`.

`area51 expose` accepts an agent group, repository, or code-change workspace and returns one consolidated assessment report. The report is designed for both humans and automation:

- `agent_gate`: prompt, skill, MCP, package, secret, scenario, and policy findings when the target is an agent
- `runtime_policy`: host-owned allow, block, quarantine, Docker, Incus container, or Incus VM decision when Agent Gate applies
- `checks`: package verification status from a named package script such as `verify`
- `findings`: normalized severity, surface, evidence, and recommendation entries
- `recommendations`: deduplicated next steps for fixing the target before release

Examples:

```sh
area51 expose \
  --path ./groups/support-agent \
  --target-type agent \
  --runtime-profile production \
  --data-sensitivity customer \
  --capabilities chat,network,package-install \
  --json-path reports/support-agent-exposure.json

area51 expose \
  --path . \
  --target-type change \
  --verify-script verify \
  --json-path reports/change-exposure.json
```

The verify step runs package scripts by name through argv-based process execution. It does not accept arbitrary shell text as an Area51 command argument.

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

## Live Incus Validation

The repository can validate the adapter contract on every operating system. A real end-to-end Incus run additionally needs a Linux machine where:

- Incus is installed and initialized
- the Area51 host user can call `incus` successfully
- the Incus socket is not mounted into agent runtimes
- the runner can create projects, profiles, instances, snapshots, and disk devices

On a self-hosted runner with those permissions, the same adapter can be exercised against the real daemon. Shared GitHub runners are still useful for the safety contract because they verify the exact argv sent to Incus and the fail-closed policy behavior.

## Commercial Licensing

Area51 is MIT licensed. Incus is Apache-2.0 licensed. Both are permissive and generally compatible with commercial use, including modification and redistribution.

Do not remove required license notices from copied source. Keep the MIT and Apache-2.0 notices with redistributed code, preserve copyright notices, and track any direct Incus code copied into Area51. The cleanest commercial route is to shell out to the Incus CLI or call its API from Area51 instead of vendoring large Incus source files.
