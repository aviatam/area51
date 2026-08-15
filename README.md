<p align="center">
  <img src="assets/area51-logo.png" alt="Area51" width="520">
</p>

<p align="center">
  AI agent containment runtime: scan, isolate, run, and quarantine autonomous agents with real workspace and runtime boundaries.
</p>

---

## What Area51 Is

Area51 is a security-first runtime for personal and team AI agents. It keeps the lightweight agent-group model, memory, messaging routes, scheduled jobs, and per-agent workspaces, then adds a stronger containment story around runtime isolation and release gates.

The first demo path combines:

- **Agent groups** with their own instructions, memory, skills, packages, and MCP servers
- **Agent Gate** scans for AI secret setup, package risk, behavior scenarios, integration health, and five-pillar readiness
- **Incus runtime planning** for per-agent projects, profiles, instances, mounts, quotas, snapshots, and quarantine flows
- **Fail-closed reports** for demos and CI

## Quick Start

```bash
git clone https://github.com/aviatam/area51.git area51
cd area51
bash area51.sh
```

Run the working containment demo:

```bash
area51 demo --output-dir .area51/demo
```

The demo creates a support-refund agent, checks AI secret configuration, scores every pillar, detects a compromised package, writes quarantine evidence, and produces the Incus freeze/snapshot/network-isolation plan.

## Demo Output

```text
.area51/demo/reports/agent-gate.json
.area51/demo/reports/incus-runtime-plan.json
.area51/demo/reports/area51-demo.json
```

Expected result:

```text
Area51 demo: VERIFIED
fail-closed gate: yes
quarantine artifacts: yes
Incus quarantine flow: yes
```

## Core Commands

```bash
area51 demo --output-dir .area51/demo
area51 agent-gate scan --path ./groups/support-agent
area51 agent-gate scan --path ./groups/support-agent --json-path reports/agent-gate.json --ci
```

## Five Pillars

- **Capabilities**: agent files, skills, and concrete behavior scenario coverage
- **Evolution**: memory and regression surfaces that let agents improve safely
- **Skill efficiency**: package footprint and dependency risk
- **Integration**: MCP and channel wiring health
- **Security**: AI secrets, policy files, runtime isolation, and quarantine evidence

## Runtime Direction

Docker remains useful for local compatibility. Incus is the stronger Area51 runtime target for Linux deployments because it gives project-level isolation, reusable profiles, resource limits, snapshots, freeze/stop controls, and VM escalation for high-risk agents.

Area51 currently generates the Incus execution plan in the demo. A live Linux runtime adapter can apply the same commands through the Incus CLI or REST API.

## Requirements

- macOS or Linux, with Windows via WSL2
- Node.js 20+ and pnpm 10+
- Docker for the default local runtime
- Incus on Linux for live Area51 isolation work

## Documentation

- [Area51 demo](docs/area51.md)
- [Agent Gate](docs/agent-gate.md)
- [Commercial licensing review](docs/commercial-licensing-review.md)
- [Architecture](docs/architecture.md)
- [Security](docs/SECURITY.md)

## License

MIT. See [LICENSE](LICENSE).
