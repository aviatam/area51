import { describe, expect, it } from 'vitest';

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
      'initial.uid=1000',
      'initial.gid=1000',
      'initial.mode=0700',
      '--project',
      'area51-maximum',
    ]);
    expect(plan.commands).toContainEqual([
      'storage',
      'volume',
      'file',
      'push',
      '--recursive',
      '--no-dereference',
      '--uid',
      '1000',
      '--gid',
      '1000',
      '/srv/area51/data/v2-sessions/group/session',
      'area51-secure',
      'maximum-session/',
      '--project',
      'area51-maximum',
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
