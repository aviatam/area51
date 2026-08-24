import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { syncIncusVmInbound, syncIncusVmOutbound } from './incus-vm-session-bridge.js';
import { buildIncusRuntimePlan } from './incus-runtime.js';

function vmPlan() {
  return buildIncusRuntimePlan({
    agentGroupFolder: 'bridge-test',
    groupDir: '/tmp/bridge-test-group',
    instanceKind: 'vm',
    image: 'local:test',
    vmDisks: {
      pool: 'default',
      volumes: [{ name: 'bridge-volume', source: '/tmp/source', path: '/workspace', readonly: false, size: '2GiB' }],
    },
  });
}

describe('Incus VM session database bridge', () => {
  it('pushes a root-only inbound snapshot and invokes the baked importer', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-inbound-bridge-'));
    try {
      fs.writeFileSync(path.join(root, 'inbound.db'), 'inbound');
      const commands: string[][] = [];
      syncIncusVmInbound(vmPlan(), root, {
        executor(argv) {
          commands.push(argv);
        },
      });

      expect(commands).toHaveLength(2);
      expect(commands[0]).toEqual(
        expect.arrayContaining(['file', 'push', '--uid', '0', '--gid', '0', '--mode', '0600']),
      );
      expect(commands[0].join(' ')).toContain('/run/area51-sync/inbound.db');
      expect(commands[1]).toEqual(expect.arrayContaining(['/app/src/vm-db-bridge.ts', 'import-inbound']));
      expect(fs.readdirSync(root)).toEqual(['inbound.db']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('atomically installs an outbound snapshot and updates host heartbeat', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-outbound-bridge-'));
    try {
      fs.writeFileSync(path.join(root, 'outbound.db'), 'old');
      const commands: string[][] = [];
      const heartbeatAt = Date.now() - 1_000;
      syncIncusVmOutbound(vmPlan(), root, {
        executor(argv) {
          commands.push(argv);
          if (argv[0] === 'file' && argv[1] === 'pull') {
            fs.writeFileSync(argv[3]!, argv[2]!.endsWith('/heartbeat') ? String(heartbeatAt) : 'new');
          }
        },
      });

      expect(commands).toHaveLength(3);
      expect(commands[0]).toEqual(expect.arrayContaining(['/app/src/vm-db-bridge.ts', 'export-outbound']));
      expect(commands[1]!.slice(0, 3)).toEqual(['file', 'pull', expect.stringContaining('/outbound.db')]);
      expect(commands[2]!.slice(0, 3)).toEqual(['file', 'pull', expect.stringContaining('/heartbeat')]);
      expect(fs.readFileSync(path.join(root, 'outbound.db'), 'utf8')).toBe('new');
      expect(fs.statSync(path.join(root, '.heartbeat')).isFile()).toBe(true);
      expect(fs.statSync(path.join(root, '.heartbeat')).mtimeMs).toBeCloseTo(heartbeatAt, -1);
      expect(fs.readdirSync(root).sort()).toEqual(['.heartbeat', 'outbound.db']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed for a non-VM plan', () => {
    const plan = buildIncusRuntimePlan({
      agentGroupFolder: 'container-test',
      groupDir: '/tmp/container-test-group',
      image: 'local:test',
    });
    expect(() => syncIncusVmInbound(plan, '/tmp')).toThrow('managed-volume VM plan');
  });
});
