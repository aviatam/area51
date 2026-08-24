import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { syncIncusVmProviderState } from './incus-vm-provider-state.js';
import { buildIncusRuntimePlan } from './incus-runtime.js';

function vmPlan(source: string, readonly = false) {
  return buildIncusRuntimePlan({
    agentGroupFolder: 'provider-state-test',
    groupDir: '/tmp/provider-state-test-group',
    instanceKind: 'vm',
    image: 'local:test',
    vmDisks: {
      pool: 'default',
      volumes: [
        { name: 'workspace', source: '/tmp/workspace', path: '/workspace', readonly: false, size: '2GiB' },
        { name: 'provider', source, path: '/home/node/.claude', readonly, size: '256MiB' },
      ],
    },
  });
}

describe('Incus VM provider-state bridge', () => {
  it('validates and atomically installs a bounded snapshot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-provider-state-'));
    const destination = path.join(root, '.claude-shared');
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, 'old.json'), 'old');
    const settings = Buffer.from('{"hooks":{"SessionStart":[]}}');
    const marker = Buffer.from('restart-ok\n');
    const files = new Map([
      ['settings.json', settings],
      ['nested/restart-proof.txt', marker],
    ]);
    const commands: string[][] = [];
    try {
      expect(
        syncIncusVmProviderState(vmPlan(destination), {
          executor(argv) {
            commands.push(argv);
            if (argv[0] !== 'file' || argv[1] !== 'pull') return;
            const guestPath = argv[2]!;
            const hostPath = argv[3]!;
            if (guestPath.endsWith('/provider-state.json')) {
              fs.writeFileSync(
                hostPath,
                JSON.stringify({
                  version: 1,
                  files: [...files].map(([file, content]) => ({
                    path: file,
                    size: content.byteLength,
                    sha256: createHash('sha256').update(content).digest('hex'),
                  })),
                }),
              );
            } else {
              const relative = guestPath.split('/provider-state/')[1]!;
              fs.writeFileSync(hostPath, files.get(relative)!);
            }
          },
        }),
      ).toBe(true);

      expect(commands[0]).toEqual(expect.arrayContaining(['/app/src/vm-db-bridge.ts', 'export-provider-state']));
      expect(fs.existsSync(path.join(destination, 'old.json'))).toBe(false);
      expect(fs.readFileSync(path.join(destination, 'settings.json'))).toEqual(settings);
      expect(fs.readFileSync(path.join(destination, 'nested', 'restart-proof.txt'))).toEqual(marker);
      expect(fs.statSync(path.join(destination, 'settings.json')).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(root)).toEqual(['.claude-shared']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects traversal before pulling files and preserves existing state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-provider-state-'));
    const destination = path.join(root, '.claude-shared');
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, 'settings.json'), 'original');
    try {
      expect(() =>
        syncIncusVmProviderState(vmPlan(destination), {
          executor(argv) {
            if (argv[0] === 'file' && argv[1] === 'pull') {
              fs.writeFileSync(
                argv[3]!,
                JSON.stringify({ version: 1, files: [{ path: '../escape', size: 0, sha256: '0'.repeat(64) }] }),
              );
            }
          },
        }),
      ).toThrow('provider-state path');
      expect(fs.readFileSync(path.join(destination, 'settings.json'), 'utf8')).toBe('original');
      expect(fs.readdirSync(root)).toEqual(['.claude-shared']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a read-only provider-state volume', () => {
    expect(() => syncIncusVmProviderState(vmPlan('/tmp/provider', true), { executor() {} })).toThrow(
      'must be writable',
    );
  });
});
