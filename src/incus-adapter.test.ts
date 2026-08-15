import { describe, expect, it, vi } from 'vitest';

import { applyIncusRuntimePlan, ensureIncusAvailable, quarantineIncusInstance } from './incus-adapter.js';
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
});
