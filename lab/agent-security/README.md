# Area51 agent security lab

This public, synthetic lab shows what Area51 reports when a customer-support agent's package and MCP configuration changes. It uses no customer records, provider credentials, or live network calls. The local run is a **policy and command-contract exercise**; it does not execute Incus.

## Run the three scenarios

From the repository root, with Node 22 and pnpm installed:

```bash
corepack pnpm install --frozen-lockfile
bash lab/agent-security/run.sh
```

The command writes `.area51/agent-security-lab/` and prints `Area51 agent security lab: VERIFIED` only after checking all nine assertions and the referenced reports. To choose another output directory, pass it as the first argument. The runner refuses to remove an existing directory; choose a fresh path or remove the previous generated output yourself.

| Scenario                 | Evidence file                                                         | What it establishes                                                                                      |
| ------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Clean support agent      | `reports/01-clean-gate.json`, `reports/01-clean-policy.json`          | Baseline scan and host runtime decision                                                                  |
| Package and MCP mutation | `reports/02-poisoned-gate.json`, `reports/02-poisoned-policy.json`    | Fresh scan detects the known compromised package; host policy chooses VM quarantine before provider work |
| Containment plan         | `reports/03-incus-vm-quarantine-plan.json`, `reports/assertions.json` | Freeze, snapshot, stop, and network removal commands are planned and the assertions pass                 |

The generated `groups/nostromo-support-agent/` contains the final mutated fixture. The first two reports preserve the clean state before the mutation; rerun the command for a fresh baseline. `reports/lab-verification.json` records the verified scenario IDs and evidence paths.

## Live containment proof

The local lab **detects** the fixture mutation and demonstrates the policy decision and containment plan. For **live containment**, inspect the [hosted-KVM acceptance run](https://github.com/aviatam/area51/actions/runs/36263347303) and its `release-acceptance-36263347303` artifact. That run tested commit `43c57d6bbea149df220cdb67120af8fe003ed0e3` and reports a real stopped VM, evidence snapshot, removed NIC, and rejected guest execution. Follow the [release evidence verifier instructions](../../README.md#reproduce-the-release-proof) to check the report contract. The verifier does not independently attest the host or the truth of the observations.

This fixture covers one known compromised package and an unknown MCP entry. It does not prove general prompt-injection prevention, arbitrary malicious-package detection, live Entra/Okta authorization, real provider credentials, or physical-host reboot. See the [full demo guide](../../docs/governed-escalation-demo.md) for the operational flow and claim boundaries.
