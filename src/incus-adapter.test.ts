import { describe, expect, it, vi } from 'vitest';

import {
  applyIncusRuntimePlan,
  ensureIncusAvailable,
  quarantineIncusInstance,
  stopIncusInstance,
} from './incus-adapter.js';
import { buildIncusRuntimePlan } from './incus-runtime.js';

describe('Incus adapter', () => {
  it('checks the Incus CLI without shell execution', () => {
    const executor = vi.fn();

    const result = ensureIncusAvailable({ executor });

    expect(result.commands).toEqual([{ argv: ['version'], ok: true, output: undefined }]);
    expect(executor).toHaveBeenCalledWith(['version']);
  });

  it('applies a runtime plan as argv commands', () => {
    const executor = vi.fn();
    const plan = buildIncusRuntimePlan({
      agentGroupFolder: 'support',
      groupDir: '/srv/area51/groups/support',
      sessionDir: '/srv/area51/sessions/support/sess-1',
    });

    applyIncusRuntimePlan(plan, { executor });

    expect(executor).toHaveBeenCalledWith(['project', 'create', 'area51-support']);
    expect(executor).toHaveBeenCalledWith(['project', 'set', 'area51-support', 'restricted=true']);
    expect(executor).toHaveBeenCalledWith(['project', 'set', 'area51-support', 'restricted.devices.disk=allow']);
    expect(executor).toHaveBeenCalledWith([
      'project',
      'set',
      'area51-support',
      `restricted.devices.disk.paths=${plan.mounts.map((mount) => mount.source).join(',')}`,
    ]);
    expect(executor).toHaveBeenCalledWith([
      'launch',
      'images:debian/12/cloud',
      'area51-support-agent',
      '--project',
      'area51-support',
      '--profile',
      'default',
      '--profile',
      'area51-agent-net',
    ]);
    expect(executor).toHaveBeenCalledWith(
      expect.arrayContaining([
        'config',
        'device',
        'add',
        'area51-support-agent',
        'workspace-agent',
        'disk',
        `source=${plan.mounts[0].source}`,
        'path=/workspace/agent',
      ]),
    );
  });

  it('treats existing projects and profiles as idempotent success', () => {
    const executor = vi.fn((argv: string[]) => {
      if (argv[0] === 'project' && argv[1] === 'create') {
        const err = new Error('Project already exists') as Error & { stderr?: string };
        err.stderr = 'already exists';
        throw err;
      }
      if (argv[0] === 'profile' && argv[1] === 'create') {
        const err = new Error('Profile already exists') as Error & { stderr?: string };
        err.stderr = 'already exists';
        throw err;
      }
    });
    const plan = buildIncusRuntimePlan({
      agentGroupFolder: 'support',
      groupDir: '/srv/area51/groups/support',
    });

    const result = applyIncusRuntimePlan(plan, { executor });

    expect(result.commands.some((command) => command.output === 'already exists')).toBe(true);
    expect(result.commands.every((command) => command.ok)).toBe(true);
  });

  it('preserves mount paths as argv values instead of interpolating shell strings', () => {
    const executor = vi.fn();
    const plan = buildIncusRuntimePlan({
      agentGroupFolder: 'shell-test',
      groupDir: '/tmp/group; touch /tmp/pwned',
    });

    applyIncusRuntimePlan(plan, { executor });

    expect(executor).toHaveBeenCalledWith(expect.arrayContaining([`source=${plan.mounts[0].source}`]));
  });

  it('quarantines with a JS timestamp instead of shell command substitution', () => {
    const executor = vi.fn();
    const plan = buildIncusRuntimePlan({
      agentGroupFolder: 'support',
      groupDir: '/srv/area51/groups/support',
    });

    quarantineIncusInstance(plan, {
      executor,
      reason: 'package-risk',
      now: new Date('2026-08-15T12:00:00.000Z'),
    });

    expect(executor).toHaveBeenCalledWith(['freeze', 'area51-support-agent', '--project', 'area51-support']);
    expect(executor).toHaveBeenCalledWith([
      'snapshot',
      'area51-support-agent',
      'area51-quarantine-2026-08-15T12-00-00-000Z',
      '--project',
      'area51-support',
    ]);
    expect(executor).toHaveBeenCalledWith([
      'profile',
      'remove',
      'area51-support-agent',
      'area51-agent-net',
      '--project',
      'area51-support',
    ]);
    expect(executor).toHaveBeenCalledWith([
      'profile',
      'add',
      'area51-support-agent',
      'area51-quarantine',
      '--project',
      'area51-support',
    ]);
    expect(executor.mock.calls.flatMap(([argv]) => argv as string[]).join(' ')).not.toContain('$(');
  });

  it('fails before running commands when plan names are unsafe', () => {
    const executor = vi.fn();
    const plan = buildIncusRuntimePlan({ agentGroupFolder: 'support', groupDir: '/srv/area51/groups/support' });
    plan.instance = 'bad;name';

    expect(() => applyIncusRuntimePlan(plan, { executor })).toThrow('Invalid Incus instance name');
    expect(executor).not.toHaveBeenCalled();
  });

  it('fails before running commands for dangerous host mounts', () => {
    const executor = vi.fn();
    const plan = buildIncusRuntimePlan({
      agentGroupFolder: 'support',
      groupDir: '/srv/area51/groups/support',
      mounts: [{ source: '/var/lib/incus/unix.socket', path: '/workspace/incus.sock', readonly: true }],
    });

    expect(() => applyIncusRuntimePlan(plan, { executor })).toThrow('Dangerous Incus host mount denied');
    expect(executor).not.toHaveBeenCalled();
  });

  it('fails before running commands for host root mounts', () => {
    const executor = vi.fn();
    const plan = buildIncusRuntimePlan({
      agentGroupFolder: 'support',
      groupDir: '/srv/area51/groups/support',
      mounts: [{ source: '/', path: '/workspace/host-root', readonly: true }],
    });

    expect(() => applyIncusRuntimePlan(plan, { executor })).toThrow('Dangerous Incus host mount denied');
    expect(executor).not.toHaveBeenCalled();
  });

  it('fails before running commands for Docker socket mounts', () => {
    const executor = vi.fn();
    const plan = buildIncusRuntimePlan({
      agentGroupFolder: 'support',
      groupDir: '/srv/area51/groups/support',
      mounts: [{ source: '/var/run/docker.sock', path: '/workspace/docker.sock', readonly: true }],
    });

    expect(() => applyIncusRuntimePlan(plan, { executor })).toThrow('Dangerous Incus host mount denied');
    expect(executor).not.toHaveBeenCalled();
  });

  it('fails before running commands for writable non-session mounts', () => {
    const executor = vi.fn();
    const plan = buildIncusRuntimePlan({
      agentGroupFolder: 'support',
      groupDir: '/srv/area51/groups/support',
      mounts: [{ source: '/srv/area51/groups/support', path: '/workspace/agent', readonly: false }],
    });

    expect(() => applyIncusRuntimePlan(plan, { executor })).toThrow('Writable Incus mount target is not allowed');
    expect(executor).not.toHaveBeenCalled();
  });

  it('stops an Incus instance by project and instance name', () => {
    const executor = vi.fn();
    const plan = buildIncusRuntimePlan({ agentGroupFolder: 'support', groupDir: '/srv/area51/groups/support' });

    stopIncusInstance(plan, { executor });

    expect(executor).toHaveBeenCalledWith(['stop', 'area51-support-agent', '--project', 'area51-support', '--force']);
  });
});
