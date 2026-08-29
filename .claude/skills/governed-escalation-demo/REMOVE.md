# Remove generated demo evidence

This skill changes no Area51 configuration. If the default deterministic command was used, remove only its generated evidence directory:

```bash
rm -rf .area51/governed-demo
```

Production mode is a real Area51 installation and writes the three non-secret Incus runtime keys documented by the skill. Use the repository's normal `bash area51.sh --uninstall` flow to remove the installation; do not delete its data or retained quarantine evidence manually.

Do not remove live Incus resources by pattern. The live E2E owns its explicitly named cleanup and reports retained quarantine evidence when cleanup is intentionally skipped after failure.
