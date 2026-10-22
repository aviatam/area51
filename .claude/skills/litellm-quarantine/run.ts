import { spawnSync, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorDependencies, writeDependencyHold, assertNoDependencyHold } from '../../../src/dependency-monitor.js';
import { scanAgentGate } from '../../../src/agent-gate.js';
import { selectLiveRuntimePolicy } from '../../../src/live-runtime-policy.js';
import { applyIncusRuntimePlan, spawnIncusExec } from '../../../src/incus-adapter.js';
import { buildIncusRuntimePlan } from '../../../src/incus-runtime.js';
import { enforceIncusRuntimeDecision } from '../../../src/incus-quarantine-policy.js';
import { litellmRelay } from './relay.js';

const skillDir = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-litellm-'));
const out = path.resolve('.area51/diagnostics/litellm');
fs.mkdirSync(out, { recursive: true });
const key = process.env.GROQ_API_KEY;
const image = process.env.AREA51_LITELLM_IMAGE;
if (!key || !image || !/^[a-zA-Z0-9-]+$/.test(image)) throw new Error('Missing demo configuration');
const suffix = (process.env.GITHUB_RUN_ID ?? String(Date.now())).replace(/[^0-9]/g, '').slice(-9);
const token = randomBytes(32).toString('hex');
const address = '10.252.0.1';
const port = 10255;
const config = {
  mcpServers: {},
  packages: { apt: ['python3'], npm: [] },
  additionalMounts: [],
  skills: 'all' as const,
  provider: 'litellm-demo',
};
fs.writeFileSync(path.join(root, 'AGENTS.md'), 'A two-turn task agent using LiteLLM.');
fs.mkdirSync(path.join(root, 'skills', 'memory'), { recursive: true });
fs.writeFileSync(path.join(root, 'skills', 'memory', 'SKILL.md'), 'Use conversation history.');
fs.writeFileSync(path.join(root, 'security-policy.md'), 'Only the host decides quarantine.');
fs.writeFileSync(path.join(root, 'requirements.txt'), 'litellm==1.106.2\n');
const relayFile = path.join(root, 'relay.json');
fs.writeFileSync(relayFile, JSON.stringify({ url: `http://${address}:${port}/v1`, token }), { mode: 0o600 });
const clean = await scanAgentGate({ groupDir: root, requiredSecrets: [], env: {}, dependencySecurity: 'required' });
if (clean.findings.some((f) => f.severity === 'high')) throw new Error('Clean control rejected');
const initial = selectLiveRuntimePolicy(clean, {
  backend: 'incus',
  incusInstanceKind: 'container',
  containerConfig: config,
});
if (initial.action !== 'allow' || initial.runtime !== 'incus-vm')
  throw new Error('Expected third-party agent VM selection');
const plan = buildIncusRuntimePlan({
  agentGroupFolder: `litellm-${suffix}`,
  groupDir: root,
  instanceKind: 'vm',
  image: `local:${image}`,
  mounts: [],
  vmNetwork: {
    network: `llm${suffix}`,
    acl: `llm-acl-${suffix}`,
    ipv4Cidr: `${address}/24`,
    oneCliAddress: address,
    oneCliPort: port,
  },
  vmDisks: {
    pool: process.env.AREA51_INCUS_STORAGE_POOL ?? 'default',
    volumes: [
      {
        name: `llm-work-${suffix}`,
        source: path.join(root, 'workspace'),
        path: '/workspace',
        readonly: false,
        size: '1GiB',
      },
    ],
  },
  vmFiles: [
    { source: path.join(skillDir, 'agent.py'), path: '/run/area51/agent.py', readonly: true },
    { source: relayFile, path: '/run/area51/litellm-relay.json', readonly: true },
  ],
});
fs.mkdirSync(path.join(root, 'workspace'));
const statuses: number[] = [];
const relay = http.createServer(litellmRelay({ token, key, record: (status) => statuses.push(status) }));
const incus = (args: string[]) =>
  execFileSync('incus', args, { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] });
let processReady: Record<string, unknown> | undefined;
let stopMonitor: (() => void) | undefined;
try {
  applyIncusRuntimePlan(plan);
  await new Promise<void>((resolve, reject) => {
    relay.once('error', reject);
    relay.listen(port, address, resolve);
  });
  const inventory = incus([
    'exec',
    plan.instance,
    '--project',
    plan.project,
    '--',
    'cat',
    '/opt/litellm/python-packages.json',
  ]);
  fs.writeFileSync(path.join(root, 'python-packages.json'), inventory);
  const installed = JSON.parse(inventory) as Array<{ name: string; version: string }>;
  if (!installed.some((p) => p.name === 'litellm' && p.version === '1.106.2'))
    throw new Error('Wrong installed control');
  fs.writeFileSync(path.join(out, 'installed-python-packages.json'), inventory);
  const installedGate = await scanAgentGate({
    groupDir: root,
    requiredSecrets: [],
    env: {},
    dependencySecurity: 'required',
  });
  if (installedGate.findings.some((f) => f.severity === 'high')) throw new Error('Installed control rejected');
  const child = spawnIncusExec(
    plan,
    '/opt/litellm/bin/python',
    ['-u', '/run/area51/agent.py'],
    { HOME: '/home/node', LITELLM_LOCAL_MODEL_COST_MAP: 'True' },
    { user: '1000', group: '1000' },
  );
  const childExit = new Promise<number | null>((resolve) => child.once('close', resolve));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Agent did not become ready')), 150000);
    let text = '';
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (!processReady) reject(new Error('Agent exited before live proof'));
    });
    child.stderr?.on('data', () => {}); // Do not print library exceptions containing request configuration.
    child.stdout?.on('data', (chunk) => {
      text += chunk.toString();
      if (text.length > 20000) {
        clearTimeout(timer);
        reject(new Error('Agent output budget'));
        return;
      }
      for (const line of text.split('\n')) {
        if (!line.startsWith('{')) continue;
        try {
          const event = JSON.parse(line);
          if (event.event === 'agent-ready' && event.litellm === '1.106.2' && event.turns === 2) {
            processReady = event;
            clearTimeout(timer);
            resolve();
            return;
          }
        } catch (_error) {
          /* wait for complete line */
        }
      }
    });
  });
  if (statuses.length !== 2 || statuses.some((s) => s !== 200)) throw new Error('Missing two real inference results');
  // Only the declaration changes. Never install, import or execute a malicious release.
  fs.writeFileSync(path.join(root, 'requirements.txt'), 'litellm==1.107.0\n');
  const { changed, decision } = await new Promise<{
    changed: Awaited<ReturnType<typeof scanAgentGate>>;
    decision: ReturnType<typeof selectLiveRuntimePolicy>;
  }>((resolve, reject) => {
    const timer = setTimeout(() => {
      stopMonitor?.();
      reject(new Error('Automatic dependency containment timed out'));
    }, 150_000);
    stopMonitor = monitorDependencies({
      groupDir: root,
      intervalMs: 1_000, // Accelerated fixture; the production host uses 60 seconds.
      current: () => true,
      error: (error) => {
        clearTimeout(timer);
        stopMonitor?.();
        reject(error);
      },
      unsafe: async (result) => {
        try {
          if (result.summary.status !== 'complete' || !result.findings.length)
            throw new Error('Automatic scanner did not produce complete findings');
          const changed = await scanAgentGate({ groupDir: root, requiredSecrets: [], env: {} });
          changed.findings.push(...result.findings);
          changed.dependency_scan = result.summary;
          if (!changed.findings.some((f) => f.id === 'pypi-litellm-compromised'))
            throw new Error('Declaration was not detected');
          const decision = selectLiveRuntimePolicy(changed, {
            backend: 'incus',
            incusInstanceKind: 'vm',
            containerConfig: config,
          });
          if (decision.action !== 'quarantine') throw new Error('Host did not choose quarantine');
          writeDependencyHold(path.join(out, 'monitor-host'), 'litellm-live', result);
          const applied = enforceIncusRuntimeDecision(decision, plan);
          if (!applied.quarantine?.commands.every((c) => c.ok)) throw new Error('Quarantine incomplete');
          let held = false;
          try {
            assertNoDependencyHold(path.join(out, 'monitor-host'), 'litellm-live');
          } catch {
            held = true;
          }
          if (!held) throw new Error('Session restart was not held');
          resolve({ changed, decision });
        } catch (error) {
          reject(error);
        } finally {
          clearTimeout(timer);
          stopMonitor?.();
        }
      },
    });
  });
  const list = JSON.parse(incus(['list', plan.instance, '--project', plan.project, '--format', 'json']));
  const instance = list.find((v: { name: string }) => v.name === plan.instance);
  const stopped = instance?.status?.toLowerCase() === 'stopped';
  const nicRemoved = !instance?.expanded_devices?.['area51-vm-net'];
  const marked = instance?.expanded_config?.['user.area51.quarantined'] === 'true';
  const snapshots = JSON.parse(
    incus(['snapshot', 'list', plan.instance, '--project', plan.project, '--format', 'json']),
  );
  const snapshot = snapshots.find((s: { name: string }) => s.name.startsWith('area51-quarantine-'))?.name;
  const blocked = spawnSync('incus', ['exec', plan.instance, '--project', plan.project, '--', 'true'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  const executionRejected = blocked.status !== null && blocked.status !== 0 && !blocked.error;
  const exited = await Promise.race([
    childExit.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10000)),
  ]);
  if (!stopped || !nicRemoved || !marked || !snapshot || !executionRejected || !exited)
    throw new Error('Observed quarantine assertions failed');
  const findings = changed.findings.filter((f) => f.id.startsWith('pypi-'));
  fs.copyFileSync(path.join(root, 'requirements.txt'), path.join(out, 'changed-requirements.txt'));
  fs.writeFileSync(
    path.join(out, 'report.json'),
    JSON.stringify(
      {
        schema: 'area51.litellm_quarantine.v1',
        measured_at: new Date().toISOString(),
        source_sha: process.env.GITHUB_SHA ?? null,
        installed_litellm: '1.106.2',
        declared_attack_version: '1.107.0',
        real_model_calls: statuses.length,
        clean_control_allowed: true,
        initial_runtime: initial.runtime,
        dependency_detected: true,
        runtime_decision: decision,
        agent: processReady,
        stopped,
        nic_removed: nicRemoved,
        quarantine_marked: marked,
        snapshot,
        agent_process_exited: exited,
        execution_rejected: executionRejected,
        malicious_package_executed: false,
        unknown_malware_detection_tested: false,
        automatic_polling_tested: true,
        monitor_test_interval_ms: 1000,
        restart_hold_verified: true,
        continuous_monitoring_tested: false,
        trigger:
          'production dependency monitor automatically polled changed host requirements.txt; installed package remained clean',
        requirements_sha256: createHash('sha256').update('litellm==1.107.0\n').digest('hex'),
        findings,
      },
      null,
      2,
    ) + '\n',
  );
  fs.writeFileSync(
    path.join(out, 'summary.md'),
    '## LiteLLM dependency quarantine\n\n| Check | Result |\n|---|---|\n| Actual LiteLLM 1.106.2 agent, two live Groq turns | ✅ |\n| Third-party agent selected VM | ✅ |\n| Changed requirement 1.107.0 detected by host gate | ✅ |\n| Running VM stopped and NIC removed | ✅ |\n| Evidence snapshot retained; execution rejected | ✅ |\n\nKnown-version declaration test. Installed library stayed clean. The production monitor automatically detected the changed host declaration with an accelerated one-second poll and persisted a restart hold. No unknown-malware or guest-installed-package attestation claimed. Disposable runner evidence expires with runner.\n',
  );
  console.log('LiteLLM live agent and observed VM quarantine passed. Evidence: .area51/diagnostics/litellm');
} finally {
  stopMonitor?.();
  relay.closeAllConnections();
  await new Promise<void>((resolve) => relay.close(() => resolve()));
  fs.rmSync(relayFile, { force: true });
  // Preserve the stopped VM and its snapshot until this disposable GitHub runner is destroyed.
}
