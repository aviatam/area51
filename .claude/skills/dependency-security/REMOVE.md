# Remove dependency security

1. Preserve required evidence and quarantine snapshots before cleanup. This skill does not release quarantined workloads.
2. Remove `AREA51_DEPENDENCY_SECURITY` and `AREA51_DEPENDENCY_SCANNER` from the host service environment and restart it through its normal deployment process.
3. Run `node .claude/skills/dependency-security/install.mjs --remove`. This deletes all three generated source/test/pin files and reverses every Agent Gate insertion. It refuses modified generated files so local edits are not discarded.
4. Remove the exact OSV-Scanner binary installed by the downloader from `data/tools/` if no other workflow uses it.
5. Remove `.area51/diagnostics/dependency-security` and the exact temporary `area51-dependency-evidence-*` directories referenced by the reports only after preserving the evidence you need.
6. Run the host typecheck and existing Agent Gate tests to verify rollback.

The existing npm and LiteLLM rules remain part of the core security gate. The skill changes no provider registry, package-manager configuration or package installation policy.
