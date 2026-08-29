---
name: governed-escalation-demo
description: Run the Area51 clean-to-poisoned escalation and quarantine proof, produce machine-readable evidence, or execute the authoritative live Incus VM version.
---

# Governed escalation demo

Use this skill when someone asks why Area51 is useful, how its governance works, or wants to demonstrate a changing agent being moved to stronger isolation and quarantined.

## Safe deterministic proof

From the Area51 repository root, run:

```bash
pnpm exec tsx ${CLAUDE_SKILL_DIR}/scripts/run.ts --output-dir .area51/governed-demo
```

Show the operator:

- `.area51/governed-demo/README.md` for the step-by-step narrative;
- `.area51/governed-demo/reports/assertions.json` for the pass/fail contract;
- the clean and poisoned Agent Gate and Runtime Policy reports under `reports/`.

The deterministic mode does not claim to execute Incus. It proves the scan, mutation, fresh policy decision, VM escalation requirement, quarantine decision, evidence creation, and exact Incus containment command contract.

## Authoritative live proof

Only run live mode on a disposable Linux host or CI runner with Incus, KVM, the Area51 VM image, and the environment required by `scripts/incus-vm-containment-e2e.ts`:

```bash
pnpm exec tsx ${CLAUDE_SKILL_DIR}/scripts/run.ts --live
```

Live mode delegates to the production hosted-KVM E2E. It creates and later cleans Incus resources, and it must never be presented as a laptop-safe dry run.

## Interpretation

- A clean third-party support agent is allowed only in the isolation selected by host policy.
- Adding a known compromised package is treated as a capability/provenance mutation.
- The next scan and decision happen from the mutated live configuration.
- Area51 does not fall back to Docker when stronger isolation is required.
- Confirmed compromise is quarantined before provider execution; the live proof verifies stopped state, snapshot evidence, quarantine marker, NIC removal, and rejected guest execution.

See `docs/governed-escalation-demo.md` for the full operator story and honest comparison boundaries.
