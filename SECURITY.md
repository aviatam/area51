# Security policy

Area51 is an experimental developer preview. No supported stable release or
security-patch support window has been published. The first certification target
is Ubuntu24.04 x86-64 with KVM/Incus VM isolation; other installer targets remain
experimental. Review [release gates](docs/linux-ga-readiness.md) and the
[security model](docs/SECURITY.md) before deployment.

## Reporting vulnerabilities

Do not put credentials, exploit details or sensitive agent data in public issues.
If GitHub offers **Report a vulnerability** on this repository, use its
[private advisory form](https://github.com/aviatam/area51/security/advisories/new).
That route requires repository-owner enablement; availability and a monitored
response process have not yet been verified for this preview. If unavailable,
request a private reporting channel from the repository owner without disclosing
vulnerability details publicly.

A verified private intake route, named response owner and patch/support policy
remain release blockers. This document does not imply a response SLA or that the
private advisory feature has been enabled. Before inviting external security
users, the owner must verify intake from a non-maintainer account, record the
responsible maintainer and publish the supported versions and response process.

## Useful report information

Include the exact commit/version, host OS and architecture, runtime backend,
reproduction steps, expected versus observed boundary behavior, and sanitized
logs. State whether the finding affects Docker compatibility, an Incus container,
a KVM VM, host tooling or the dependency gate. Never include API keys or real
customer data; use synthetic canaries where possible.
