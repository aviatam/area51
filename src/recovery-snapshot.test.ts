import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createSnapshot, restoreSnapshot, verifySnapshot } from './recovery-snapshot.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'area51-recovery-')));
  dirs.push(dir);
  const install = path.join(dir, 'install');
  const hostConfig = path.join(dir, 'config');
  fs.mkdirSync(path.join(install, 'data', 'v2-sessions', 'agent'), { recursive: true });
  fs.mkdirSync(path.join(install, 'groups', 'agent'), { recursive: true });
  fs.mkdirSync(path.join(install, 'store'), { recursive: true });
  fs.mkdirSync(hostConfig);
  fs.writeFileSync(path.join(install, 'data', 'v2.db'), 'fixture-database');
  fs.writeFileSync(path.join(install, 'data', 'v2-sessions', 'agent', 'conversation.json'), '{"message":"preserved"}');
  fs.writeFileSync(path.join(install, 'groups', 'agent', 'CLAUDE.md'), 'instructions');
  fs.writeFileSync(path.join(install, '.env'), 'SYNTHETIC_SECRET=fixture');
  fs.writeFileSync(path.join(hostConfig, 'tool-actions.json'), '{"token":"synthetic-secret"}');
  const options = {
    install,
    hostConfig,
    output: path.join(dir, 'snapshot'),
    commit: 'a'.repeat(40),
    offlineAcknowledged: true,
  };
  return { dir, install, hostConfig, options, create: () => createSnapshot(options) };
}

it('round-trips populated host state and credentials into private staging, without overwriting source', () => {
  const f = fixture();
  const r = f.create();
  fs.writeFileSync(path.join(f.install, 'data', 'v2.db'), 'after-upgrade');
  const stage = path.join(f.dir, 'restored');
  restoreSnapshot(f.options.output, r.manifestSha256, stage);
  expect(fs.readFileSync(path.join(stage, 'install', 'data', 'v2.db'), 'utf8')).toBe('fixture-database');
  expect(fs.readFileSync(path.join(f.install, 'data', 'v2.db'), 'utf8')).toBe('after-upgrade');
  expect(fs.readFileSync(path.join(stage, 'host-config', 'tool-actions.json'), 'utf8')).toContain('synthetic-secret');
  expect(JSON.parse(fs.readFileSync(path.join(stage, 'RESTORED.json'), 'utf8'))).toMatchObject({
    activationAllowed: false,
    externalWritesReconciled: false,
  });
  if (process.platform !== 'win32') {
    expect(fs.statSync(stage).mode & 0o077).toBe(0);
    expect(fs.statSync(path.join(stage, 'host-config', 'tool-actions.json')).mode & 0o077).toBe(0);
  }
});
it('requires explicit offline acknowledgement and an exact commit', () => {
  const f = fixture();
  expect(() => createSnapshot({ ...f.options, offlineAcknowledged: false })).toThrow('Stop all');
  expect(() => createSnapshot({ ...f.options, commit: 'main' })).toThrow('Exact code');
  expect(fs.existsSync(f.options.output)).toBe(false);
});
it('requires central database rather than creating a deceptively empty snapshot', () => {
  const f = fixture();
  fs.unlinkSync(path.join(f.install, 'data', 'v2.db'));
  expect(f.create).toThrow('Central database');
});
it('never overwrites existing snapshot or restoration destinations', () => {
  const f = fixture();
  const r = f.create();
  expect(f.create).toThrow();
  expect(() => restoreSnapshot(f.options.output, r.manifestSha256, f.install)).toThrow();
  expect(fs.readFileSync(path.join(f.install, '.env'), 'utf8')).toContain('SYNTHETIC_SECRET');
});
it('rejects overlap with source directories', () => {
  const f = fixture();
  expect(() => createSnapshot({ ...f.options, output: path.join(f.install, 'backup') })).toThrow('overlap');
});
it('rejects modified manifest, corrupt payload and additional unrecorded files', () => {
  const f = fixture();
  const r = f.create();
  const payload = path.join(f.options.output, 'payload');
  fs.writeFileSync(path.join(payload, 'host-config', 'extra'), 'unrecorded');
  expect(() => verifySnapshot(f.options.output, r.manifestSha256)).toThrow('integrity');
  fs.unlinkSync(path.join(payload, 'host-config', 'extra'));
  fs.writeFileSync(path.join(payload, 'install', 'data', 'v2.db'), 'corrupt');
  expect(() => restoreSnapshot(f.options.output, r.manifestSha256, path.join(f.dir, 'restore'))).toThrow('integrity');
  expect(fs.existsSync(path.join(f.dir, 'restore'))).toBe(false);
  fs.appendFileSync(path.join(f.options.output, 'manifest.json'), ' ');
  expect(() => verifySnapshot(f.options.output, r.manifestSha256)).toThrow('digest');
});
it('does not restore an incomplete interrupted snapshot', () => {
  const f = fixture();
  const r = f.create();
  fs.unlinkSync(path.join(f.options.output, 'COMPLETE'));
  expect(() => restoreSnapshot(f.options.output, r.manifestSha256, path.join(f.dir, 'restore'))).toThrow();
});
it('does not mark a snapshot complete when source state changes during capture', () => {
  const f = fixture();
  const original = fs.copyFileSync;
  let changed = false;
  vi.spyOn(fs, 'copyFileSync').mockImplementation((...args) => {
    original(...args);
    if (!changed) {
      fs.writeFileSync(path.join(f.install, '.env'), 'changed-while-copying');
      changed = true;
    }
  });
  expect(f.create).toThrow();
  expect(fs.existsSync(path.join(f.options.output, 'COMPLETE'))).toBe(false);
});
it('rejects symlinked restore payloads before creating staging', () => {
  if (process.platform === 'win32') return;
  const f = fixture();
  const r = f.create();
  const file = path.join(f.options.output, 'payload', 'install', '.env');
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(f.install, '.env'), file);
  expect(() => restoreSnapshot(f.options.output, r.manifestSha256, path.join(f.dir, 'restore'))).toThrow('Symbolic');
  expect(fs.existsSync(path.join(f.dir, 'restore'))).toBe(false);
});
it.skipIf(process.platform === 'win32')(
  'rejects symlinks and hard links instead of escaping the declared scope',
  () => {
    const f = fixture();
    fs.symlinkSync(f.hostConfig, path.join(f.install, 'groups', 'escape'));
    expect(f.create).toThrow('Symbolic');
    fs.unlinkSync(path.join(f.install, 'groups', 'escape'));
    fs.linkSync(path.join(f.install, '.env'), path.join(f.install, 'store', 'hard-link'));
    expect(f.create).toThrow('Regular');
  },
);
