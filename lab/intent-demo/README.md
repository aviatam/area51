# Area51 + Mend Intent demo

![Area51 + Mend Intent demo](evidence/area51-intent-demo.gif)

## How it works, in one paragraph

**Area51 decides where an agent may run and keeps it in a box. Mend Intent decides
whether a package is safe by running it first.** Area51 alone contains the damage: the
agent never sees host credentials, but a malicious package it installs still runs inside
the box and can steal what the agent can see. Intent alone stops the package, but nothing
contains the agent itself, so a prompt-injected command reads your real credentials.
Together, Agent Gate asks Intent about every pinned dependency before launch (a blocked
package means quarantine, and the agent never starts), Area51 mounts the Intent shim as
the agent's `npm` so runtime installs are judged too, and the sandbox keeps whatever slips
past both away from the host. Area51 stays fully open source; Intent is an optional
provider turned on by two settings.

## Result

| Setup | Zero-day npm package | Prompt-injected `cat ~/.aws/credentials` |
|---|---|---|
| Area51 alone | ✘ ran in the sandbox: workspace data leaked, persistence hook planted | ✔ contained: no host credentials in the sandbox |
| Intent alone | ✔ blocked at install | ✘ host credentials and token exfiltrated |
| **Area51 + Intent** | ✔ blocked before launch (quarantine) **and** at runtime install | ✔ contained |

Evidence: [`evidence/area51-intent-demo.mp4`](evidence/area51-intent-demo.mp4) (also as
[GIF](evidence/area51-intent-demo.gif) and an [asciinema cast](evidence/area51-intent-demo.cast)),
and the machine-readable [`evidence/evidence.json`](evidence/evidence.json).

## Turning Intent on

| Setting | Meaning |
|---|---|
| `AREA51_INTENT_API_URL` | `intent-api` base URL. Unset = open-source mode, nothing changes |
| `AREA51_INTENT_TOKEN` | an Intent analysis token (`intent_tok_…`) |
| `AREA51_INTENT_MODE` | `required` (default: unknown or unreachable = fail closed) or `advisory` (warnings) |
| `AREA51_INTENT_WAIT_MS` | how long the gate waits for analyses still running (default 10000) |
| `AREA51_INTENT_SHIM` | path to the Linux `intent` binary; mounts it as the agent's `npm`/`npx` (Docker runtime) |
| `AREA51_INTENT_CONTAINER_API_URL` | API URL as seen from the agent container (default: the host URL with `localhost` → `host.docker.internal`) |

## Run it

Needs Docker and a checkout of [mend/intent](https://github.com/mend/intent) with its
local stack (`deploy/local`) and Linux shim (`make build-shim-all`).

```bash
INTENT_REPO=../intent lab/intent-demo/run-demo.sh          # setup + three scenes + result
lab/intent-demo/run-demo.sh teardown
```

## What is real and what is staged

- **Real:** Area51's Agent Gate, OSV advisory scan, Runtime Policy and startup check; the
  Intent client in `src/intent-verdicts.ts`; `intent-api` with Postgres and token auth; the
  Intent shim refusing the tarball by its SHA-256; the payload actually running and the sink
  actually receiving data.
- **Seeded:** Intent's verdict for the two demo packages. Intent produces verdicts by
  detonating the package in a Firecracker microVM, which needs Linux with KVM; on a Mac the
  verdict is published with `tools/verdictseed`, bound to the exact tarball hash.
- **Simulated:** the sandbox is a `node:22-slim` container with the same hardening flags as
  Area51's Docker runtime (`--cap-drop=ALL`, `no-new-privileges`, `--init`, pid limit,
  non-root, workspace-only mounts), not the full agent image. The "developer host" is a
  container with canary credentials in its home. All credentials, customers and the
  attacker endpoint are synthetic and stay on a private Docker network.

## Known limits

- The runtime shim is wired into the Docker runtime only; the Incus path still relies on
  the pre-launch gate.
- The agent container receives the Intent analysis token (it can query verdicts and
  enqueue analyses, nothing else). A host-side relay would keep it on the host.
- The shim covers npm/npx in this integration; Intent's uv and gem shims can be added the
  same way.
