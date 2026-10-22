# Roll back native dependency security

Stop the host, preserve holds and evidence, and restore a reviewed previous Area51 release with its corresponding configuration. Do not remove native scanner modules or clear holds to bypass a failed scan. Follow `docs/automatic-security-migration.md` for detection, remediation, verification and controlled hold release.

The former installer `--remove` is intentionally rejected now that live enforcement is built in.
