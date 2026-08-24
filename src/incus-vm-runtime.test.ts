import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildIncusVmRuntimeTransport } from './incus-vm-runtime.js';

describe('Incus VM live runtime transport', () => {
  it('converts runtime directories to managed volumes and immutable files to bootstrap pushes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-vm-runtime-'));
    try {
      const session = path.join(root, 'session');
      const group = path.join(root, 'group');
      const runner = path.join(root, 'runner');
      const credential = path.join(root, 'credential-stub');
      fs.mkdirSync(session);
      fs.mkdirSync(group);
      fs.mkdirSync(runner);
      fs.writeFileSync(path.join(group, 'container.json'), '{}');
      fs.writeFileSync(credential, 'onecli-managed');

      const result = buildIncusVmRuntimeTransport(
        [
          { source: session, path: '/workspace', readonly: false },
          { source: group, path: '/workspace/agent', readonly: true },
          {
            source: path.join(group, 'container.json'),
            path: '/workspace/agent/container.json',
            readonly: true,
          },
          { source: runner, path: '/app/src', readonly: true },
          { source: credential, path: '/home/node/.config/tool/auth.json', readonly: true },
        ],
        'support-session-1',
      );

      expect(result.volumes).toEqual([
        expect.objectContaining({ source: session, path: '/workspace', readonly: false, size: '2GiB' }),
        expect.objectContaining({ source: group, path: '/workspace/agent', readonly: true, size: '256MiB' }),
      ]);
      expect(result.files).toEqual([{ source: credential, path: '/home/node/.config/tool/auth.json', readonly: true }]);
      expect(result.volumes.map((volume) => volume.name)).toEqual([
        expect.stringMatching(/^a51-support-session-1-[0-9a-f]{8}-1$/),
        expect.stringMatching(/^a51-support-session-1-[0-9a-f]{8}-2$/),
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed on writable file mounts and read-only volume overrides', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-vm-runtime-deny-'));
    try {
      const session = path.join(root, 'session');
      const group = path.join(root, 'group');
      const override = path.join(root, 'override');
      fs.mkdirSync(session);
      fs.mkdirSync(group);
      fs.writeFileSync(override, 'override');

      expect(() =>
        buildIncusVmRuntimeTransport(
          [
            { source: session, path: '/workspace', readonly: false },
            { source: override, path: '/tmp/writable', readonly: false },
          ],
          'deny',
        ),
      ).toThrow('Writable Incus VM file mounts are forbidden');
      expect(() =>
        buildIncusVmRuntimeTransport(
          [
            { source: session, path: '/workspace', readonly: false },
            { source: group, path: '/workspace/agent', readonly: true },
            { source: override, path: '/workspace/agent/container.json', readonly: true },
          ],
          'deny',
        ),
      ).toThrow('file override inside a read-only managed volume is unsupported');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires the writable session boundary', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-vm-runtime-workspace-'));
    try {
      expect(() =>
        buildIncusVmRuntimeTransport([{ source: root, path: '/workspace', readonly: true }], 'deny'),
      ).toThrow('requires a writable /workspace managed volume');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
