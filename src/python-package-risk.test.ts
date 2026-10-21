import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanAgentGate } from './agent-gate.js';
import { selectLiveRuntimePolicy } from './live-runtime-policy.js';
import { buildIncusRuntimePlan } from './incus-runtime.js';
import { enforceIncusRuntimeDecision } from './incus-quarantine-policy.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function group(file: string, content: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'litellm-risk-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'A test agent using LiteLLM.');
  fs.mkdirSync(path.join(root, 'skills', 'memory'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'memory', 'SKILL.md'), 'Keep session memory.');
  fs.writeFileSync(path.join(root, 'container.json'), JSON.stringify({ mcpServers: { test: { command: 'test' } } }));
  fs.writeFileSync(path.join(root, 'security-policy.md'), 'Host controls execution.');
  fs.mkdirSync(path.join(root, '.area51', 'agent-gate', 'scenarios'), { recursive: true });
  fs.writeFileSync(path.join(root, '.area51', 'agent-gate', 'scenarios', 'dependency.json'), '{}');
  fs.writeFileSync(path.join(root, file), content);
  return root;
}
const config = { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all' as const };

describe('LiteLLM dependency gate integration', () => {
  it.each(['1.82.7', '1.82.8', '1.107.0'])(
    'quarantines known malicious release %s through the real policy and adapter',
    async (version) => {
      const root = group('requirements.txt', `LiteLLM[proxy] == ${version} ; python_version >= "3.10"\n`);
      const report = await scanAgentGate({ groupDir: root, requiredSecrets: [], env: {}, quarantine: false });
      expect(report.findings.some((f) => f.id === 'pypi-litellm-compromised')).toBe(true);
      const decision = selectLiveRuntimePolicy(report, {
        backend: 'incus',
        incusInstanceKind: 'vm',
        containerConfig: config,
      });
      expect(decision.action).toBe('quarantine'); // Even when copying evidence is disabled.
      const plan = buildIncusRuntimePlan({
        agentGroupFolder: 'litellm',
        groupDir: root,
        instanceKind: 'vm',
        mounts: [],
        vmNetwork: {
          network: 'litellm-net',
          acl: 'litellm-acl',
          ipv4Cidr: '10.90.0.1/24',
          oneCliAddress: '10.90.0.1',
          oneCliPort: 10255,
        },
        vmDisks: {
          pool: 'default',
          volumes: [{ name: 'litellm-workspace', source: root, path: '/workspace', readonly: false, size: '1GiB' }],
        },
      });
      const executor = vi.fn();
      enforceIncusRuntimeDecision(decision, plan, { executor });
      expect(executor).toHaveBeenCalledWith(['stop', plan.instance, '--force', '--project', plan.project]);
      expect(
        selectLiveRuntimePolicy(report, { backend: 'docker', incusInstanceKind: 'container', containerConfig: config })
          .action,
      ).toBe('block');
    },
  );
  it('matches an installed transitive pip inventory and preserves original evidence', async () => {
    const text = JSON.stringify([
      { name: 'some-agent', version: '1.0' },
      { name: 'litellm', version: '1.107.0' },
    ]);
    const root = group('python-packages.json', text);
    const report = await scanAgentGate({ groupDir: root, requiredSecrets: [], env: {} });
    expect(report.passed).toBe(false);
    expect(fs.readFileSync(path.join(report.quarantine.path!, 'python-packages.json'), 'utf8')).toBe(text);
  });
  it('allows the reviewed control version without treating every LiteLLM installation as malicious', async () => {
    const root = group('requirements.txt', 'litellm==1.106.2 # control\n');
    const report = await scanAgentGate({ groupDir: root, requiredSecrets: [], env: {} });
    expect(report.passed).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.quarantine.files).toEqual([]);
  });
  it.each(['litellm>=1.0', 'litellm', 'litellm @ https://example.invalid/package.whl', 'litellm==1.107.*'])(
    'fails closed on unresolved declaration %s',
    async (declaration) => {
      const root = group('requirements.lock', declaration);
      const report = await scanAgentGate({ groupDir: root, requiredSecrets: [], env: {} });
      expect(report.findings.some((f) => f.id === 'pypi-litellm-unresolved')).toBe(true);
    },
  );
  it('fails closed on malformed inventory instead of reporting a clean scan', async () => {
    const root = group('python-packages.json', '{bad');
    const report = await scanAgentGate({ groupDir: root, requiredSecrets: [], env: {} });
    expect(report.findings.some((f) => f.id === 'pypi-inventory-invalid')).toBe(true);
  });
});
