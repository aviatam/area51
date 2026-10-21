# Remove the disposable proof

The GitHub runner destroys its image, VM and temporary relay capability when the job finishes. Preserve downloaded evidence before deleting its Actions artifact.

For an explicitly operator-run local experiment, inspect the `area51-litellm-*` Incus project and preserve its quarantine snapshot before deliberately deleting the disposable VM/project, managed workspace volume, `llm*` network and matching `llm-acl-*` ACL. Delete only resources identified by that run's suffix. Remove the exact image alias supplied in `AREA51_LITELLM_IMAGE` when finished.

Remove `.area51/diagnostics/litellm` to delete local exported reports. The demo registers no provider, modifies no production service and stores no real API key in guest files.
