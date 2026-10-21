# Remove Groq MVP

From the repository root, run
`node .claude/skills/groq-mvp/install.mjs --remove`.
This deletes both copied files and the registration import. It refuses to
overwrite or remove files modified since installation.
Remove `AREA51_GROQ_RELAY_URL` and `AREA51_GROQ_RELAY_TOKEN` from the launcher,
select an installed provider in `container.json`, and rebuild the VM image.
Archive or delete the session's `groq-history.json` according to your retention
policy. Host secrets are managed separately by the operator.
