import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { prepareRestoredState } from './recovery-reconciliation.js';

it('requires an explicit offline acknowledgement before accessing state', () => {
  expect(() => prepareRestoredState('/does-not-exist', false)).toThrow('offline acknowledgement');
});
it.each(['corrupt', 'mismatched', 'activation-edited'])(
  'refuses %s restore provenance before opening a database',
  (kind) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'area51-reconcile-test-')));
    try {
      fs.mkdirSync(path.join(root, 'install', 'data'), { recursive: true });
      const common = { commit: 'a'.repeat(40), manifestSha256: 'b'.repeat(64), activationAllowed: false };
      fs.writeFileSync(
        path.join(root, 'RESTORED.json'),
        JSON.stringify({ ...common, schema: 'area51.host-state-restored.v1' }),
        { mode: 0o600 },
      );
      fs.writeFileSync(
        path.join(root, 'install', 'data', 'recovery-hold.json'),
        kind === 'corrupt'
          ? '{'
          : JSON.stringify({
              ...common,
              schema: 'area51.recovery-hold.v1',
              ...(kind === 'mismatched' ? { commit: 'c'.repeat(40) } : { activationAllowed: true }),
            }),
        { mode: 0o600 },
      );
      expect(() => prepareRestoredState(root, true)).toThrow();
      expect(fs.existsSync(path.join(root, 'install', 'data', 'v2.db'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
