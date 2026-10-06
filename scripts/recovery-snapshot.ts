import { execFileSync } from 'node:child_process';
import { createSnapshot, restoreSnapshot, verifySnapshot } from '../src/recovery-snapshot.js';

const [command, first, second, third, fourth] = process.argv.slice(2);
if (command === 'create' && first && second && third && fourth === '--offline') {
  const commit = execFileSync('git', ['-C', first, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const result = createSnapshot({
    install: first,
    hostConfig: second,
    output: third,
    commit,
    offlineAcknowledged: true,
  });
  console.log(JSON.stringify({ manifestSha256: result.manifestSha256, commit, files: result.manifest.entries.length }));
} else if (command === 'verify' && first && second && !third) {
  const result = verifySnapshot(first, second);
  console.log(JSON.stringify({ verified: true, commit: result.commit, entries: result.entries.length }));
} else if (command === 'restore' && first && second && third && !fourth) {
  const result = restoreSnapshot(first, second, third);
  console.log(JSON.stringify({ restoredToStaging: true, commit: result.commit, activationAllowed: false }));
} else {
  console.error(
    'Usage: create INSTALL HOST_CONFIG NEW_SNAPSHOT --offline | verify SNAPSHOT DIGEST | restore SNAPSHOT DIGEST NEW_STAGING',
  );
  process.exitCode = 2;
}
