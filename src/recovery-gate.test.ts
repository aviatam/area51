import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { enforceRecoveryGate, RECOVERY_HOLD_FILE } from './recovery-gate.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-hold-'));
  roots.push(root);
  const install = path.join(root, 'install');
  fs.mkdirSync(path.join(install, 'data'), { recursive: true });
  return { root, install, marker: path.join(install, 'data', RECOVERY_HOLD_FILE) };
}
it('allows normal installations without a recovery marker', () => {
  expect(() => enforceRecoveryGate(fixture().install)).not.toThrow();
});
it.each(['{}', 'corrupt', '{"activationAllowed":true}'])('blocks even a malformed or edited hold marker: %s', (raw) => {
  const f = fixture();
  fs.writeFileSync(f.marker, raw);
  expect(() => enforceRecoveryGate(f.install)).toThrow('Restored installation is held');
});
it('blocks older staging restores which only have the PR47 marker', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.root, 'RESTORED.json'), '{}');
  expect(() => enforceRecoveryGate(f.install)).toThrow('Restored installation is held');
});
it.skipIf(process.platform === 'win32')(
  'blocks a dangling symbolic-link marker rather than treating it as absent',
  () => {
    const f = fixture();
    fs.symlinkSync(path.join(f.root, 'missing'), f.marker);
    expect(() => enforceRecoveryGate(f.install)).toThrow('Restored installation is held');
  },
);
it('checks the gate before startup backoff, DB initialization and channel startup', () => {
  const source = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const main = source.slice(source.indexOf('async function main()'));
  for (const seam of ['enforceStartupBackoff()', 'initDb(dbPath)', 'await initChannelAdapters('])
    expect(main.indexOf('enforceRecoveryGate(process.cwd())')).toBeLessThan(main.indexOf(seam));
});
