# Preserve surviving reservations before preparation

Restoring an older snapshot can lose tool-action request reservations written after that snapshot. Those request IDs must stay blocked even when the external write's outcome is unknown. This offline import unions a surviving central database's reservations into a held restore, without dispatching actions or removing the hold.

## Operator order

1. Stop the host, containers, service restart policies and every database writer. Preserve the surviving installation and its SQLite sidecars together. Use a canonical, owner-only regular database file; do not copy only the main file while WAL state exists. The tool reads the committed logical ledger through SQLite, including WAL state.
2. Restore the verified snapshot into a fresh held staging directory. Independently verify that the surviving database belongs to this installation and that all relevant reservations survived. The ledger digest binds rows; it does not prove their origin, completeness or external outcomes.
3. Inspect the surviving ledger, retain the count and digest privately, then import using that exact digest:

   ```bash
   node --import tsx scripts/recovery-reservations.ts inspect /absolute/surviving/data/v2.db --offline
   node --import tsx scripts/recovery-reservations.ts import /absolute/staging /absolute/surviving/data/v2.db EXPECTED_LEDGER_DIGEST --offline
   ```

4. Run the existing offline preparation only after importing. Preparation invalidates stale approvals and binds the resulting logical database and restored payload. Repeating the import before preparation returns its original audit only if the audit and target ledger remain unchanged; repeating it after preparation refuses rather than changing bound state.

Output contains counts and digests, never request IDs or credentials. The target transaction preserves existing reservations and timestamps, adds missing IDs and records import provenance. Failures roll back the entire import. The source opens read-only; SQLite may create or update its coordination sidecars, so preserve the source directory and use private permissions.

## Refusals and limitations

The operation refuses changed source evidence, missing ledgers, invalid rows, conflicting reservation timestamps, sessions absent from the restored backup, unsafe database paths, missing recovery holds and previously prepared state. A new post-snapshot session is intentionally a refusal: importing that session's identity and permissions requires a separate reconciliation design. Each source and the resulting union are limited to 50,000 reservations.

If no trustworthy surviving ledger exists, do not claim post-snapshot replay protection. Independent external audit reconciliation remains necessary for ambiguous effects, missing reservations, provider state, approvals and other dispatch surfaces. A restored request with a different ID is not covered by this import.

All reports keep `externalEffectsReconciled: false` and `activationAllowed: false`; import reports also keep `postSnapshotEffectsKnown: false`. There is no activation path here. Do not remove the recovery hold. The real HTTP regression proves that one imported post-snapshot request ID cannot execute twice through the tool-action service; it does not prove healthy host startup or a clean-host recovery drill. GA-04 remains open.
