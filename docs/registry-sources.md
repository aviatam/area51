# Optional registry sources

Area51 does not currently publish readable first-party `channels`/`providers`
registry branches or a public template registry. The setup instructions for those
optional add-ons describe a source format, not an available hosted service.
Fresh-agent and local-template setup do not require a public template registry.
Installing a channel or a provider whose implementation is absent from this
checkout requires obtaining and reviewing that implementation first.

## Configure a registry source

Only use a repository whose adapter/provider code you trust: skills can execute
host installation commands. Do not point at the former upstream as an automatic
fallback. Inspect the implementation and its registration tests before applying.

If you have a trusted repository carrying the required registry branch:

```bash
git remote add my-registry https://github.com/YOUR-ORGANIZATION/YOUR-REGISTRY.git
git ls-remote --exit-code --heads my-registry refs/heads/channels
# For a provider instead, verify refs/heads/providers.
export AREA51_CHANNELS_REMOTE=my-registry
```

Then run the relevant setup add-on. The resolver checks branch readability before
copying any payload. It does not add remotes, substitute repositories or bypass
repository authentication. `absent or inaccessible` means either the branch is
missing or Git cannot read it; verify the URL, credentials and branch separately.
The override names an existing Git remote, and applies to both channel and
provider registry branches. A published source must contain the exact files the
chosen skill requests, including tests; a branch name alone is insufficient.

## Templates

Choose **fresh agent** or a template already in the local `templates/` directory
for setup without a remote library. To use your own reviewed template Git repository:

```bash
export AREA51_TEMPLATES_SOURCE=https://github.com/YOUR-ORGANIZATION/YOUR-TEMPLATES.git
bash area51.sh
```

A local Git repository path is also accepted. See [templates](templates.md) for
plugin format and local stamping. Nothing silently falls back to an unpublished
Area51 repository or an unrelated upstream.

## Existing installations

Detect: optional installs fail fetching `channels`, `providers` or the old template
URL. Why: those public first-party registries are not published. Fix: use an
existing installed adapter, a fresh agent/local template, or explicitly configure
a trusted readable source as above. Verify the branch and run the skill's real
registration tests. Rollback: unset `AREA51_CHANNELS_REMOTE` and
`AREA51_TEMPLATES_SOURCE`; remove only a remote you added yourself. These settings
do not change already installed agent data or adapters.
