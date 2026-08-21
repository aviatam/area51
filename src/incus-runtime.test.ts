import path from 'path';

import { describe, expect, it } from 'vitest';

import { buildIncusRuntimePlan, formatIncusRuntimePlan } from './incus-runtime.js';

describe('buildIncusRuntimePlan', () => {
  it('maps an agent group to an isolated Incus project and instance', () => {
    const plan = buildIncusRuntimePlan({
      agentGroupFolder: 'Support Refund Agent',
      groupDir: path.join('tmp', 'support-agent'),
      sessionDir: path.join('tmp', 'session'),
    });

    expect(plan.project).toBe('area51-support-refund-agent');
    expect(plan.instance).toBe('area51-support-refund-agent-agent');
    expect(plan.image).toBe('local:area51-agent-v2');
    expect(plan.profiles).toContain('area51-agent-net');
    expect(plan.mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/workspace/agent', readonly: true }),
        expect.objectContaining({ path: '/workspace', readonly: false }),
      ]),
    );
    expect(plan.mounts.map((mount) => mount.path)).toEqual(['/workspace', '/workspace/agent']);
    expect(plan.restrictions['security.privileged']).toBe('false');
    expect(plan.commands.quarantine).toEqual(
      expect.arrayContaining([
        expect.stringContaining('incus freeze area51-support-refund-agent-agent'),
        expect.stringContaining('incus profile add area51-support-refund-agent-agent area51-quarantine'),
      ]),
    );
  });

  it('formats a concise operator plan', () => {
    const plan = buildIncusRuntimePlan({ agentGroupFolder: 'demo', groupDir: '.' });

    expect(formatIncusRuntimePlan(plan)).toContain('Incus runtime: area51-demo/area51-demo-agent');
  });

  it('accepts host-computed mounts for the live runner path', () => {
    const plan = buildIncusRuntimePlan({
      agentGroupFolder: 'demo',
      groupDir: '.',
      mounts: [
        { source: '/srv/area51/sessions/s1', path: '/workspace', readonly: false },
        { source: '/srv/area51/groups/demo/CLAUDE.md', path: '/workspace/agent/CLAUDE.md', readonly: true },
      ],
    });

    expect(plan.mounts).toEqual([
      { source: '/srv/area51/sessions/s1', path: '/workspace', readonly: false },
      { source: '/srv/area51/groups/demo/CLAUDE.md', path: '/workspace/agent/CLAUDE.md', readonly: true },
    ]);
    expect(plan.commands.launch.join('\n')).toContain('readonly=true');
  });

  it('can scope live instances by session while keeping the project stable', () => {
    const plan = buildIncusRuntimePlan({
      agentGroupFolder: 'support',
      groupDir: '.',
      instanceSuffix: 'session-1234567890abcdef-extra',
    });

    expect(plan.project).toBe('area51-support');
    expect(plan.instance).toBe('area51-support-session-12345678-agent');
    expect(plan.instance.length).toBeLessThanOrEqual(63);
  });
});
