import { importSurvivingReservations, inspectSurvivingReservations } from '../src/recovery-reservations.js';

const [command, first, second, third, fourth, extra] = process.argv.slice(2);
if (command === 'inspect' && first && second === '--offline' && !third) {
  console.log(JSON.stringify(inspectSurvivingReservations(first, true)));
} else if (command === 'import' && first && second && third && fourth === '--offline' && !extra) {
  console.log(JSON.stringify(importSurvivingReservations(first, second, third, true)));
} else {
  console.error('Usage: inspect SURVIVING_DB --offline | import STAGING SURVIVING_DB EXPECTED_LEDGER_DIGEST --offline');
  process.exitCode = 2;
}
