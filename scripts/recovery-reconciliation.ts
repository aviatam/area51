import { prepareRestoredState } from '../src/recovery-reconciliation.js';

const [command, staging, offline, extra] = process.argv.slice(2);
if (command !== 'prepare' || !staging || offline !== '--offline' || extra) {
  console.error('Usage: prepare RESTORED_STAGING --offline');
  process.exitCode = 2;
} else {
  const report = prepareRestoredState(staging, true);
  // Detailed identifiers remain in the private restored database audit record.
  console.log(
    JSON.stringify({
      prepared: true,
      invalidatedApprovals: report.invalidatedApprovals.length,
      uncertainReservations: report.uncertainReservations.length,
      reservationLedgerPresent: report.reservationLedgerPresent,
      activationAllowed: false,
      externalEffectsReconciled: false,
    }),
  );
}
