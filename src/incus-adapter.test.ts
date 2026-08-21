import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  applyIncusRuntimePlan,
  ensureIncusAvailable,
  ensureIncusRuntimeReady,
  quarantineIncusInstance,
  stopIncusInstance,
} from './incus-adapter.js';
import { buildIncusRuntimePlan } from './incus-runtime.js';

describe('Incus adapter', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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
      'init',
      'local:area51-agent-v2',
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
        'workspace',
        'disk',
        `source=${plan.mounts.find((mount) => mount.path === '/workspace')?.source}`,
        'shift=true',
        'path=/workspace',
      ]),
    );
    expect(executor).toHaveBeenCalledWith(
      expect.arrayContaining([
        'config',
        'device',
        'add',
        'area51-support-agent',
        'workspace-agent',
        'disk',
        `source=${plan.mounts.find((mount) => mount.path === '/workspace/agent')?.source}`,
        'path=/workspace/agent',
      ]),
    );
    expect(executor).toHaveBeenCalledWith(['start', 'area51-support-agent', '--project', 'area51-support']);
  });

  it('adds a project root disk when an Incus storage pool is configured', () => {
    vi.stubEnv('AREA51_INCUS_STORAGE_POOL', 'default');
    const executor = vi.fn();
    const plan = buildIncusRuntimePlan({
      agentGroupFolder: 'support',
      groupDir: '/srv/area51/groups/support',
      sessionDir: '/srv/area51/sessions/support/sess-1',
    });

    applyIncusRuntimePlan(plan, { executor });

    expect(executor).toHaveBeenCalledWith([
      'profile',
      'device',
      'add',
      'default',
      'root',
      'disk',
      'path=/',
      'pool=default',
      '--project',
      'area51-support',
    ]);
  });

  it('prepares nested mount targets inside the writable workspace before starting Incus', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-incus-test-'));
    try {
      const sessionDir = path.join(root, 'session');
      const groupDir = path.join(root, 'group');
      fs.mkdirSync(sessionDir);
      fs.mkdirSync(groupDir);
      const executor = vi.fn();
      const plan = buildIncusRuntimePlan({
        agentGroupFolder: 'support',
        groupDir,
        sessionDir,
      });

      applyIncusRuntimePlan(plan, { executor });

      expect(fs.statSync(path.join(sessionDir, 'agent')).isDirectory()).toBe(true);
      const calls = executor.mock.calls.map(([argv]) => argv as string[]);
      const agentDevice = calls.find((argv) => argv.includes('path=/workspace/agent'));
      const start = calls.find((argv) => argv[0] === 'start');
      expect(agentDevice).toBeDefined();
      expect(start).toBeDefined();
      expect(calls.indexOf(agentDevice!)).toBeLessThan(calls.indexOf(start!));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

  it('reuses an existing session instance and its devices on restart', () => {
    const executor = vi.fn((argv: string[]) => {
      if (argv[0] === 'init' || (argv[0] === 'config' && argv[1] === 'device' && argv[2] === 'add')) {
        throw new Error('already exists');
      }
      if (argv[0] === 'start') throw new Error('Instance is already running');
    });
    const plan = buildIncusRuntimePlan({
      agentGroupFolder: 'support',
      groupDir: '/srv/area51/groups/support',
      sessionDir: '/srv/area51/sessions/support/sess-1',
    });

    const result = applyIncusRuntimePlan(plan, { executor });

    expect(result.commands.every((command) => command.ok)).toBe(true);
    expect(result.commands.some((command) => command.output === 'already exists')).toBe(true);
    expect(result.commands.some((command) => command.output === 'already running')).toBe(true);
  });

  it('checks that a live instance contains the Area51 runtime', () => {
    const executor = vi.fn();
    const plan = buildIncusRuntimePlan({ agentGroupFolder: 'support', groupDir: '/srv/area51/groups/support' });

    ensureIncusRuntimeReady(plan, { executor });

    expect(executor).toHaveBeenCalledWith([
      'exec',
      'area51-support-agent',
      '--project',
      'area51-support',
      '--',
      'test',
      '-x',
      '/usr/local/bin/bun',
    ]);
    expect(executor).toHaveBeenCalledWith(expect.arrayContaining(['test', '-d', '/app/node_modules']));
  });

  it('adds only a loopback-bound OneCLI proxy relay', () => {
    const executor = vi.fn();
    const plan = buildIncusRuntimePlan({
      agentGroupFolder: 'support',
      groupDir: '/srv/area51/groups/support',
      gatewayProxy: { listen: 'tcp:127.0.0.1:10255', connect: 'tcp:127.0.0.1:10255' },
    });

    applyIncusRuntimePlan(plan, { executor });

    expect(executor).toHaveBeenCalledWith([
      'config',
      'device',
      'add',
      'area51-support-agent',
      'onecli-gateway',
      'proxy',
      'listen=tcp:127.0.0.1:10255',
      'connect=tcp:127.0.0.1:10255',
      'bind=instance',
      '--project',
      'area51-support',
    ]);
  });

  it('rejects a gateway relay that exposes a non-loopback endpoint', () => {
    const plan = buildIncusRuntimePlan({
      agentGroupFolder: 'support',
      groupDir: '/srv/area51/groups/support',
      gatewayProxy: { listen: 'tcp:0.0.0.0:10255', connect: 'tcp:127.0.0.1:10255' },
    });

    expect(() => applyIncusRuntimePlan(plan, { executor: vi.fn() })).toThrow('Unsafe Incus gateway proxy listen');
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
