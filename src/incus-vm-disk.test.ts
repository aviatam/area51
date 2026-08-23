import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path, { resolve } from 'node:path';

import { buildIncusVmDiskPlan } from './incus-vm-disk.js';

describe('Incus VM managed disk contract', () => {
  const options = {
    project: 'area51-maximum',
    instance: 'area51-maximum-session-agent',
    pool: 'area51-secure',
    volumes: [
      {
        name: 'maximum-session',
        source: '/srv/area51/data/v2-sessions/group/session',
        path: '/workspace',
        readonly: false,
        size: '2GiB',
      },
      {
        name: 'maximum-runtime',
        source: '/srv/area51/container/agent-runner',
        path: '/app',
        readonly: true,
        size: '1GiB',
      },
    ],
  };

  it('creates and populates project-scoped filesystem volumes', () => {
    const plan = buildIncusVmDiskPlan(options);

    expect(plan.commands).toContainEqual([
      'storage',
      'volume',
      'create',
      'area51-secure',
      'maximum-session',
      'size=2GiB',
      '--project',
      'area51-maximum',
    ]);
    expect(plan.commands).toContainEqual([
      'storage',
      'volume',
      'file',
      'push',
      '--no-dereference',
      '--uid',
      '1000',
      '--gid',
      '1000',
      resolve('/srv/area51/data/v2-sessions/group/session'),
      'area51-secure',
      'maximum-session/',
      '--project',
      'area51-maximum',
    ]);
  });

  it('stages directory trees one entry at a time without recursive CLI flags', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-vm-disk-'));
    try {
      fs.mkdirSync(path.join(root, 'nested'));
      fs.writeFileSync(path.join(root, 'top.txt'), 'top');
      fs.writeFileSync(path.join(root, 'nested', 'child.txt'), 'child');

      const plan = buildIncusVmDiskPlan({
        ...options,
        volumes: [{ ...options.volumes[0], source: root }],
      });
      const pushes = plan.prepareCommands.filter(
        (command) => command.slice(0, 4).join(' ') === 'storage volume file push',
      );

      expect(pushes).toHaveLength(2);
      expect(pushes.flat()).not.toContain('--recursive');
      expect(pushes).toContainEqual(expect.arrayContaining([path.join(root, 'top.txt'), 'maximum-session/top.txt']));
      expect(pushes).toContainEqual(
        expect.arrayContaining([path.join(root, 'nested', 'child.txt'), 'maximum-session/nested/child.txt']),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('initializes writable mount ownership inside the running guest', () => {
    const plan = buildIncusVmDiskPlan(options);

    expect(plan.initializeCommands).toEqual([
      ['exec', 'area51-maximum-session-agent', '--project', 'area51-maximum', '--', 'chown', '1000:1000', '/workspace'],
      ['exec', 'area51-maximum-session-agent', '--project', 'area51-maximum', '--', 'chmod', '0700', '/workspace'],
    ]);
  });

  it('attaches managed volumes instead of host paths', () => {
    const plan = buildIncusVmDiskPlan(options);

    expect(plan.commands).toContainEqual([
      'config',
      'device',
      'add',
      'area51-maximum-session-agent',
      'area51-disk-1',
      'disk',
      'pool=area51-secure',
      'source=maximum-session',
      'path=/workspace',
      '--project',
      'area51-maximum',
    ]);
    expect(plan.commands).toContainEqual(expect.arrayContaining(['source=maximum-runtime', 'readonly=true']));
    expect(plan.commands.flat().join(' ')).not.toContain('source=/srv/area51');
  });

  it.each([
    ['empty plan', { volumes: [] }],
    ['relative source', { volumes: [{ ...options.volumes[0], source: '../session' }] }],
    ['host root', { volumes: [{ ...options.volumes[0], source: '/' }] }],
    ['runtime socket', { volumes: [{ ...options.volumes[0], source: '/var/lib/incus/unix.socket' }] }],
    ['SSH credentials', { volumes: [{ ...options.volumes[0], source: '/home/operator/.ssh' }] }],
    ['guest root', { volumes: [{ ...options.volumes[0], path: '/' }] }],
    ['unexpected writable target', { volumes: [{ ...options.volumes[0], path: '/app' }] }],
    ['invalid size', { volumes: [{ ...options.volumes[0], size: 'unlimited' }] }],
    ['unsafe pool', { pool: 'pool;escape' }],
    ['duplicate volume', { volumes: [options.volumes[0], options.volumes[0]] }],
  ])('fails closed for %s', (_label, override) => {
    expect(() => buildIncusVmDiskPlan({ ...options, ...override })).toThrow();
  });
});
