# Remove generated demo evidence

This skill changes no Area51 configuration. If the default deterministic command was used, remove only its generated evidence directory:

```bash
rm -rf .area51/governed-demo
```

Do not remove live Incus resources by pattern. The live E2E owns its explicitly named cleanup and reports retained quarantine evidence when cleanup is intentionally skipped after failure.
