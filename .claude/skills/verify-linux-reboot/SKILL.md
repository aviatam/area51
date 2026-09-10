---
name: verify-linux-reboot
description: Record and verify a real Linux host reboot after an Area51 production installation. Use when validating service recovery, Incus images, governance evidence, or physical-reboot readiness. Linux only; do not use a container restart as reboot evidence.
---

# Verify Linux Reboot

Use this workflow on the Linux/KVM host where Area51 was installed. It records the
kernel boot ID before shutdown and requires a different boot ID afterward, so a
service restart cannot be reported as physical-reboot evidence.

## Record before reboot

From the Area51 checkout, immediately after the production installer succeeds:

```bash
pnpm exec tsx .claude/skills/verify-linux-reboot/scripts/verify.ts record
```

The command refuses to overwrite an existing baseline. Use `record --replace` only
when deliberately starting a new reboot test; replacing it after reboot destroys the
previous proof.

Reboot the physical host using the operator's normal approved procedure. Do not let
an agent reboot a shared or production machine without explicit authorization.

## Verify after reboot

Return to the same checkout and run:

```bash
pnpm exec tsx .claude/skills/verify-linux-reboot/scripts/verify.ts verify
```

The command exits nonzero unless all checks pass: a changed Linux boot ID, active
Incus and Area51 egress services, an active slug-scoped Area51 user service, both
governed Incus images, successful governance deployment evidence, and a clean Git
checkout at the same commit as the baseline. It writes owner-readable JSON evidence to
`.area51/reboot-verification/report.json`.

This is a recovery checklist, not production certification. A changed kernel boot
ID does not distinguish a VM reboot from a physical machine reboot or establish
power-cycle evidence. Services being active and image aliases existing do not prove
an agent task succeeds or containment is enforced after reboot. Governance evidence
is a historical local report, not a fresh policy evaluation. Run live containment
and provider tasks after reboot, and test Entra/Okta with real assigned and denied
accounts using `/configure-enterprise-sso`. The report is local, unsigned evidence
and assumes a trusted operator and checkout.

## Test the verifier

```bash
pnpm exec vitest --config vitest.skills.config.ts run \
  .claude/skills/verify-linux-reboot/tests/verify.test.ts
```

## Troubleshooting

- `boot-id-changed` fails: the host has not rebooted since the baseline was recorded,
  or the baseline was replaced afterward.
- A service check fails: inspect it with `systemctl status incus.service`,
  `systemctl status area51-incus-egress.service`, or the slug-scoped user unit from
  `setup/lib/install-slug.sh`.
- An image check fails: rerun the production installer; do not weaken the expected
  image names.
- Governance evidence fails: rerun the governed deployment before recording a new
  baseline.
