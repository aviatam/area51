import fs from 'node:fs';
import path from 'node:path';

export const RECOVERY_HOLD_FILE = 'recovery-hold.json';

/** Restored state must not reconnect channels or replay work by merely booting.
 * A reconciled activation workflow is intentionally not implemented here. */
export function enforceRecoveryGate(install: string): void {
  const markers = [
    path.join(install, 'data', RECOVERY_HOLD_FILE),
    // PR47 staging restores predate the enforced in-install hold marker.
    path.join(path.dirname(install), 'RESTORED.json'),
  ];
  for (const marker of markers) {
    try {
      const stat = fs.lstatSync(marker);
      if (stat)
        throw new Error(
          'Restored installation is held: reconcile external effects and pending work before activation.',
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
