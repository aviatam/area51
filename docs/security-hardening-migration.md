# Secure staging and containment migration

## Detect

This candidate hardens required dependency scanning and runtime containment. Before upgrading, check that the host is Linux with real procfs mounted at `/proc`, and that every component of the absolute group path is a real directory rather than a symlink. Required scans on other hosts fail closed. This is an intentional restriction of the experimental support matrix.

## Why

Path-based directory traversal could follow an ancestor substituted during a scan. Linux descriptor-relative traversal now anchors directories and rejects symlink ancestors and leaves. Actual bytes read, including concurrent file growth, count against the per-file and aggregate limits. A private host-owned staging destination remains required. This does not attest installed dependencies or defend against a compromised host administrator.

Containment must not treat the exit of a Docker/Incus CLI client as proof that its workload stopped. Stop operations are bounded and query runtime state; failures remain errors. Isolation takes priority over snapshot preservation. Consult hold records and host logs before releasing any session.

## Fix

1. Stop the host service and retain its data, holds, runtime identities and evidence. Do not remove a hold to bypass incomplete coverage.
2. Use a Linux host. Relocate symlinked group roots to real directories on trusted host storage, preserving permissions and contents; update the installation path/configuration before restarting. Do not introduce writable parent directories for untrusted users.
3. Supply reviewed workload-matching resolved inventory using the documented inventory bootstrap path. An unrelated clean lockfile is not a substitute for the agent's dependencies.
4. Verify the pinned pnpm workspace setting is the top-level `minimumReleaseAge: 4320`. No release-age exclusions or build-script allowlist additions are needed.

## Verify

Run the dependency-security, dependency-monitor, container-runtime and Incus adapter tests, host typecheck and the portable test suite. Then run a benign incident through the normal runner on the intended Linux runtime. Confirm stopped state, the applicable network isolation, durable hold and preservation of evidence after controller restart. Unit tests do not replace this live acceptance gate.

## Rollback

Stop the controller, independently verify affected workloads are stopped, and preserve holds and evidence before restoring a reviewed previous revision. Older staging code does not provide this boundary protection; do not scan hostile mutable trees with it. Restoring source must not automatically release held workloads.
