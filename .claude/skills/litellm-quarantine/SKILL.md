---
name: litellm-quarantine
description: Demonstrate a real LiteLLM task agent and host-enforced VM quarantine for a known malicious dependency declaration.
---

# LiteLLM quarantine proof

Run the `LiteLLM live agent quarantine` GitHub workflow on a KVM-capable disposable Ubuntu runner. The repository requires a host-side `GROQ_API_KEY` Actions secret. The workflow builds a clean image with exactly LiteLLM 1.106.2, then runs the skill's `run.ts` with the normal Area51 Incus policy, managed disk/network and quarantine APIs.

The Python task agent calls the actual LiteLLM completion API for two live Groq turns. Only a two-request relay capability enters the VM; the real provider key remains in the host process. The initial third-party workload is selected for VM isolation before it runs.

The harness changes the host-side root `requirements.txt` declaration to `litellm==1.107.0`, lets the production dependency monitor detect it automatically (one-second test interval; 60 seconds in production), and enforces the returned quarantine decision on the existing VM. It verifies the stopped state, removed NIC, evidence snapshot, exited process and rejected execution. It also verifies a persistent session restart hold. Initial declared control inventories receive a real OSV scan. Review `report.json` and the workflow summary.

## Evidence limits

This is a known-version declaration test. The installed package remains 1.106.2 throughout. Never install/import/download 1.107.0, 1.82.7 or 1.82.8 as part of this workflow. The test does not prove detection of unknown malware, compromise during installation, guest package attestation, long-duration advisory monitoring, or live migration of an already running container. The process starts in a VM; quarantine stops it rather than continuing risky execution.

Core Agent Gate scans root `requirements.txt`, `requirements.lock` and a `python-packages.json` exported with `pip list --format=json`. Nested requirements, pyproject.toml, uv/Poetry lockfiles and arbitrary Docker layers are outside this scanner's coverage. An inventory describes versions; it does not attest to file integrity. Exact unblocked versions are not a blanket safety certification. Unresolved LiteLLM declarations fail closed for review.

The image build pins the top-level LiteLLM version; transitive Python dependencies are resolved at build time and recorded in the exported inventory. The proof is not a fully reproducible, hash-locked Python build. The stopped VM snapshot exists only until the disposable runner is destroyed; exported reports remain as Actions artifacts.

## Installation and removal

The skill is runnable directly from its own directory in the repository; applying it changes no provider registry, production configuration or service. Its workflow owns the disposable image/VM. See REMOVE.md for evidence cleanup.

## Troubleshooting

Check nested KVM and Incus guest-agent readiness before model calls. A missing key, Groq quota, empty reply or inference error fails the proof. Failure is not evidence of successful quarantine. Download the Actions evidence artifact for the report; inspect the CI job logs for infrastructure failures.
