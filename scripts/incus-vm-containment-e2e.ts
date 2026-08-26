/** Live Incus VM disk, network, host-isolation, and cleanup containment test. */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { applyIncusRuntimePlan, deleteIncusRuntime, spawnIncusExec } from '../src/incus-adapter.js';
import type { AgentGateReport } from '../src/agent-gate.js';
import type { ContainerConfig } from '../src/container-config.js';
import { ensureSchema, insertMessage, openInboundDb, openOutboundDb } from '../src/db/session-db.js';
import { enforceIncusRuntimeDecision } from '../src/incus-quarantine-policy.js';
import { buildIncusRuntimePlan } from '../src/incus-runtime.js';
import { buildIncusVmRuntimeTransport } from '../src/incus-vm-runtime.js';
import { syncIncusVmProviderState } from '../src/incus-vm-provider-state.js';
import { syncIncusVmInbound, syncIncusVmOutbound } from '../src/incus-vm-session-bridge.js';
import { selectLiveRuntimePolicy, writeLiveRuntimePolicyDecision } from '../src/live-runtime-policy.js';

const suffix = (process.env.GITHUB_RUN_ID ?? String(Date.now())).replace(/[^0-9]/g, '').slice(-12);
const image = process.env.AREA51_INCUS_VM_IMAGE_ALIAS;
const pool = process.env.AREA51_INCUS_STORAGE_POOL ?? 'default';
if (!image) throw new Error('AREA51_INCUS_VM_IMAGE_ALIAS is required');

const relayAddress = '10.251.0.1';
const relayPort = 10255;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-vm-e2e-'));
const sessionDir = path.join(root, 'session');
const groupDir = path.join(root, 'group');
const providerDir = path.join(root, '.claude-shared');
fs.mkdirSync(sessionDir);
fs.mkdirSync(groupDir);
fs.mkdirSync(providerDir);
fs.writeFileSync(path.join(providerDir, 'settings.json'), '{}\n');
fs.writeFileSync(path.join(sessionDir, 'input.txt'), 'session-input\n');
fs.writeFileSync(path.join(groupDir, 'agent.txt'), 'agent-definition\n');
fs.symlinkSync('/app/CLAUDE.md', path.join(groupDir, '.claude-shared.md'));
const riskyConfig: ContainerConfig = {
  mcpServers: {},
  packages: { apt: ['git'], npm: ['third-party-tool'] },
  additionalMounts: [{ hostPath: groupDir, containerPath: '/project' }],
  skills: 'all',
};
const gateReport = cleanGateReport(groupDir);
const blockedLocalDecision = selectLiveRuntimePolicy(gateReport, {
  backend: 'docker',
  incusInstanceKind: 'container',
  containerConfig: riskyConfig,
});
if (blockedLocalDecision.action !== 'block' || blockedLocalDecision.runtime !== undefined) {
  throw new Error(`Risky local policy did not fail closed: ${JSON.stringify(blockedLocalDecision)}`);
}
const runtimeDecision = selectLiveRuntimePolicy(gateReport, {
  backend: 'incus',
  incusInstanceKind: 'container',
  containerConfig: riskyConfig,
});
if (runtimeDecision.action !== 'allow' || runtimeDecision.runtime !== 'incus-vm') {
  throw new Error(`Production policy did not escalate to a VM: ${JSON.stringify(runtimeDecision)}`);
}
const decisionPath = writeLiveRuntimePolicyDecision(root, `vm-e2e-${suffix}`, runtimeDecision);
if ((fs.statSync(decisionPath).mode & 0o777) !== 0o600) throw new Error('Runtime Policy decision is not mode 0600');
if (path.dirname(decisionPath).startsWith(sessionDir))
  throw new Error('Runtime Policy decision leaked into session mounts');
const inboundPath = path.join(sessionDir, 'inbound.db');
const outboundPath = path.join(sessionDir, 'outbound.db');
ensureSchema(inboundPath, 'inbound');
ensureSchema(outboundPath, 'outbound');
const inbound = openInboundDb(inboundPath);
inbound
  .prepare(
    `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
     VALUES ('e2e', 'E2E channel', 'channel', 'test', 'e2e-platform', NULL)`,
  )
  .run();
insertTestMessage(inbound, 'vm-roundtrip-1', 'first message');
inbound.close();
const bootstrapFile = path.join(root, 'onecli-bootstrap');
fs.writeFileSync(bootstrapFile, 'onecli-bootstrap\n');
const roundtripScript = path.join(root, 'roundtrip.ts');
fs.writeFileSync(
  roundtripScript,
  [
    "import { runPollLoop } from '/app/src/poll-loop.ts';",
    "import { MockProvider } from '/app/src/providers/mock.ts';",
    'const provider = new MockProvider({}, () => \'<message to="e2e">area51-vm-roundtrip-ok</message>\');',
    "await runPollLoop({ provider, providerName: 'mock', cwd: '/workspace/agent' });",
  ].join('\n'),
);
const providerStateScript = path.join(root, 'provider-state.ts');
fs.writeFileSync(
  providerStateScript,
  [
    "import fs from 'node:fs';",
    "import { MEMORY_SESSION_HOOK } from '/app/src/memory/session-hook.ts';",
    "import { ClaudeProvider } from '/app/src/providers/claude.ts';",
    'new ClaudeProvider({}).registerMemorySessionHook(MEMORY_SESSION_HOOK);',
    "const marker = '/home/node/.claude/restart-proof.txt';",
    "if (process.argv[2] === 'write') fs.writeFileSync(marker, 'area51-provider-restart-ok\\n');",
    "if (fs.readFileSync(marker, 'utf8').trim() !== 'area51-provider-restart-ok') throw new Error('provider marker missing');",
    "const settings = JSON.parse(fs.readFileSync('/home/node/.claude/settings.json', 'utf8'));",
    "if (!settings.hooks?.SessionStart?.length) throw new Error('Claude SessionStart hook missing');",
    "console.log('area51-claude-provider-state-ok');",
  ].join('\n'),
);

function makeTransport(name: string) {
  return buildIncusVmRuntimeTransport(
    [
      { source: sessionDir, path: '/workspace', readonly: false },
      { source: groupDir, path: '/workspace/agent', readonly: true },
      { source: providerDir, path: '/home/node/.claude', readonly: false },
      { source: bootstrapFile, path: '/run/area51/bootstrap.txt', readonly: true },
      { source: roundtripScript, path: '/run/area51/roundtrip.ts', readonly: true },
      { source: providerStateScript, path: '/run/area51/provider-state.ts', readonly: true },
    ],
    name,
  );
}
const transport = makeTransport(`vm-e2e-${suffix}`);
const network = `vme${suffix}`;
const acl = `vm-acl-${suffix}`;
function makePlan(instanceSuffix: string, runtimeTransport: typeof transport) {
  return buildIncusRuntimePlan({
    agentGroupFolder: `vm-e2e-${suffix}`,
    groupDir,
    mounts: [],
    instanceKind: runtimeDecision.runtime === 'incus-vm' ? 'vm' : 'container',
    instanceSuffix,
    image: `local:${image}`,
    vmNetwork: {
      network,
      acl,
      ipv4Cidr: `${relayAddress}/24`,
      oneCliAddress: relayAddress,
      oneCliPort: relayPort,
    },
    vmDisks: { pool, volumes: runtimeTransport.volumes },
    vmFiles: runtimeTransport.files,
  });
}
const plan = makePlan(suffix, transport);
const runtimeResources = [{ plan, transport }];

let relay: net.Server | undefined;
let primaryFailure: unknown;
try {
  process.env.AREA51_INCUS_STORAGE_POOL = pool;
  enforceIncusRuntimeDecision(runtimeDecision, plan);
  applyIncusRuntimePlan(plan, {
    executor(argv) {
      const output = runIncus(argv);
      if (argv[0] === 'network' && argv[1] === 'create') {
        relay = net.createServer((socket) => {
          socket.end('HTTP/1.1 200 OK\r\nContent-Length: 17\r\nConnection: close\r\n\r\narea51-relay-ok\n');
        });
        relay.listen(relayPort, relayAddress);
      }
      return output;
    },
  });

  const liveInstances = JSON.parse(
    runIncus(['list', plan.instance, '--project', plan.project, '--format', 'json']),
  ) as Array<{ type?: string }>;
  if (liveInstances.length !== 1 || liveInstances[0]?.type !== 'virtual-machine') {
    throw new Error(`Runtime Policy did not create a real Incus VM: ${JSON.stringify(liveInstances)}`);
  }

  const result = await guestScript();
  if (!result.includes('area51-vm-containment-ok')) throw new Error(`Guest did not report success: ${result}`);
  const runner = spawnIncusExec(plan, 'bun', ['run', '/run/area51/roundtrip.ts'], {}, { user: '1000', group: '1000' });
  let runnerStderr = '';
  runner.stderr?.on('data', (chunk) => (runnerStderr += chunk.toString()));
  runner.on('error', (error) => {
    runnerStderr += `\nspawn error: ${String(error)}`;
  });

  await waitForRoundTrips(1, () => runnerStderr);
  const followupDb = openInboundDb(inboundPath);
  insertTestMessage(followupDb, 'vm-roundtrip-2', 'warm follow-up');
  followupDb.close();
  syncIncusVmInbound(plan, sessionDir);
  await waitForRoundTrips(2, () => runnerStderr);

  const providerStart = await runGuest(plan, 'bun', ['run', '/run/area51/provider-state.ts', 'write']);
  if (!providerStart.includes('area51-claude-provider-state-ok')) {
    throw new Error(`Claude provider startup failed: ${providerStart}`);
  }
  if (!syncIncusVmProviderState(plan)) throw new Error('Claude provider state volume was not synchronized');
  if (fs.readFileSync(path.join(providerDir, 'restart-proof.txt'), 'utf8').trim() !== 'area51-provider-restart-ok') {
    throw new Error('Host provider-state snapshot is missing the restart marker');
  }
  deleteIncusRuntime(plan);

  const restartTransport = makeTransport(`vm-e2e-${suffix}-restart`);
  const restartPlan = makePlan(`${suffix}-r`, restartTransport);
  runtimeResources.push({ plan: restartPlan, transport: restartTransport });
  applyIncusRuntimePlan(restartPlan, { executor: runIncus });
  const providerRestart = await runGuest(restartPlan, 'bun', ['run', '/run/area51/provider-state.ts', 'verify']);
  if (!providerRestart.includes('area51-claude-provider-state-ok')) {
    throw new Error(`Claude provider restart failed: ${providerRestart}`);
  }

  const quarantineDecision = selectLiveRuntimePolicy(compromisedGateReport(groupDir), {
    backend: 'incus',
    incusInstanceKind: 'vm',
    containerConfig: riskyConfig,
  });
  if (quarantineDecision.action !== 'quarantine' || quarantineDecision.runtime !== 'incus-vm') {
    throw new Error(`Compromised package evidence did not select VM quarantine: ${JSON.stringify(quarantineDecision)}`);
  }
  const quarantine = enforceIncusRuntimeDecision(quarantineDecision, restartPlan);
  if (!quarantine.quarantine?.commands.every((command) => command.ok)) {
    throw new Error(`Live Incus quarantine commands failed: ${JSON.stringify(quarantine.quarantine)}`);
  }
  const quarantinedInstances = JSON.parse(
    runIncus(['list', restartPlan.instance, '--project', restartPlan.project, '--format', 'json']),
  ) as Array<{
    status?: string;
    config?: Record<string, string>;
    expanded_config?: Record<string, string>;
    expanded_devices?: Record<string, unknown>;
  }>;
  const quarantined = quarantinedInstances[0];
  if (quarantinedInstances.length !== 1 || quarantined?.status?.toLowerCase() !== 'stopped') {
    throw new Error(`Quarantined VM is not stopped: ${JSON.stringify(quarantinedInstances)}`);
  }
  if (quarantined.config?.['user.area51.quarantine_reason'] == null) {
    throw new Error('Quarantined VM is missing its evidence reason');
  }
  if (quarantined.expanded_config?.['user.area51.quarantined'] !== 'true') {
    throw new Error('Quarantined VM is missing its quarantine profile marker');
  }
  if (quarantined.expanded_devices?.['area51-vm-net'] != null) {
    throw new Error('Quarantined VM retained its normal network device');
  }
  const snapshots = JSON.parse(
    runIncus(['snapshot', 'list', restartPlan.instance, '--project', restartPlan.project, '--format', 'json']),
  ) as Array<{ name?: string }>;
  if (!snapshots.some((snapshot) => snapshot.name?.startsWith('area51-quarantine-'))) {
    throw new Error(`Quarantined VM evidence snapshot is missing: ${JSON.stringify(snapshots)}`);
  }
  const blockedExecution = spawnSync(
    'incus',
    ['exec', restartPlan.instance, '--project', restartPlan.project, '--', 'true'],
    { encoding: 'utf8', timeout: 30_000 },
  );
  if (blockedExecution.status === 0) throw new Error('Agent execution remained possible after quarantine');

  console.log(
    'Live Runtime Policy selection, quarantine enforcement, Incus VM containment, database round-trip, and Claude provider restart E2E passed.',
  );
} catch (error) {
  primaryFailure = error;
  throw error;
} finally {
  relay?.close();
  cleanup(primaryFailure === undefined);
  fs.rmSync(root, { recursive: true, force: true });
}

function insertTestMessage(db: ReturnType<typeof openInboundDb>, id: string, content: string): void {
  insertMessage(db, {
    id,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: 'e2e-platform',
    channelType: 'test',
    threadId: 'e2e-thread',
    content: JSON.stringify({ text: content, sender_name: 'E2E' }),
    processAfter: null,
    recurrence: null,
  });
}

function cleanGateReport(groupPath: string): AgentGateReport {
  return {
    schema: 'area51.agent_gate.v1',
    generated_at: new Date().toISOString(),
    group_path: groupPath,
    passed: true,
    overall_fitness_index: 100,
    thresholds: { minimum_overall: 80, fail_on_warnings: false },
    counts: {
      files_scanned: 3,
      agent_files: 1,
      policy_files: 1,
      scenario_files: 1,
      mcp_servers: 0,
      packages: 0,
      findings: 0,
      high_findings: 0,
    },
    secrets: [{ name: 'ANTHROPIC_API_KEY', present: true, source: 'environment' }],
    pillars: {
      capabilities: { score: 100, status: 'pass', highlights: [] },
      evolution: { score: 100, status: 'pass', highlights: [] },
      skill_efficiency: { score: 100, status: 'pass', highlights: [] },
      integration: { score: 100, status: 'pass', highlights: [] },
      security: { score: 100, status: 'pass', highlights: [] },
    },
    findings: [],
    quarantine: { enabled: true, files: [] },
    recommendations: [],
  };
}

function compromisedGateReport(groupPath: string): AgentGateReport {
  const report = cleanGateReport(groupPath);
  report.passed = false;
  report.overall_fitness_index = 10;
  report.counts.packages = 1;
  report.counts.findings = 1;
  report.counts.high_findings = 1;
  report.findings = [
    {
      id: 'npm-compromised-package',
      severity: 'high',
      pillar: 'security',
      title: 'Compromised package',
      detail: 'Hosted KVM quarantine evidence',
      evidence: ['third-party-tool'],
      recommendation: 'quarantine',
    },
  ];
  report.quarantine.files = [path.join(groupPath, '.area51', 'quarantine', 'findings.json')];
  return report;
}

async function waitForRoundTrips(expected: number, runnerStderr: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let last = 'no snapshot';
  while (Date.now() < deadline) {
    try {
      syncIncusVmOutbound(plan, sessionDir);
      const out = openOutboundDb(outboundPath);
      const messages = out.prepare('SELECT content FROM messages_out ORDER BY seq').all() as Array<{ content: string }>;
      const completed = (
        out.prepare("SELECT COUNT(*) AS count FROM processing_ack WHERE status = 'completed'").get() as {
          count: number;
        }
      ).count;
      out.close();
      const texts = messages.map((row) => (JSON.parse(row.content) as { text?: string }).text);
      last = `messages=${texts.length}, completed=${completed}, texts=${JSON.stringify(texts)}`;
      if (
        messages.length === expected &&
        completed === expected &&
        texts.every((text) => text === 'area51-vm-roundtrip-ok')
      ) {
        return;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${expected} VM round-trip(s): ${last}; runner stderr=${runnerStderr()}`);
}

function runIncus(argv: string[]): string {
  return execFileSync('incus', argv, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000,
  });
}

async function guestScript(): Promise<string> {
  const script = String.raw`
set -eu
fail() { echo "VM containment failure: $*" >&2; exit 42; }

ready=false
for _ in $(seq 1 60); do
  if test -r /workspace/input.txt && test -r /workspace/agent/agent.txt; then ready=true; break; fi
  sleep 2
done
test "$ready" = true || fail "managed volumes did not mount"
[ "$(cat /workspace/input.txt)" = session-input ] || fail "session volume content mismatch"
[ "$(cat /workspace/agent/agent.txt)" = agent-definition ] || fail "agent volume content mismatch"
[ "$(cat /run/area51/bootstrap.txt)" = onecli-bootstrap ] || fail "bootstrap file content mismatch"
[ "$(stat -c %a /run/area51/bootstrap.txt)" = 444 ] || fail "bootstrap file is not read-only"
[ "$(stat -c %u /run/area51/bootstrap.txt)" = 0 ] || fail "bootstrap file is not root-owned"
[ "$(readlink /workspace/agent/.claude-shared.md)" = /app/CLAUDE.md ] || fail "safe runtime symlink missing"
echo guest-write > /workspace/result.txt || fail "managed session volume is not writable"
if echo forbidden > /workspace/agent/forbidden 2>/tmp/readonly.err; then fail "agent volume is writable"; fi

for forbidden in /run/incus/unix.socket /var/lib/incus/unix.socket /run/docker.sock /var/run/docker.sock /host-secret.txt; do
  test ! -e "$forbidden" || fail "host control path visible: $forbidden"
done
if echo forbidden > /container-root-marker 2>/tmp/root.err; then fail "non-root user can write guest root"; fi

relay=false
for _ in $(seq 1 30); do
  if curl -fsS --connect-timeout 1 http://${relayAddress}:${relayPort}/health | grep -qx area51-relay-ok; then relay=true; break; fi
  sleep 1
done
test "$relay" = true || fail "allowlisted relay is unreachable"
if curl -fsS --connect-timeout 2 --max-time 3 http://1.1.1.1/ >/tmp/open-egress 2>&1; then
  fail "non-relay internet egress succeeded"
fi
echo area51-vm-containment-ok
`;

  return runGuest(plan, 'bash', ['-lc', script]);
}

async function runGuest(runtimePlan: typeof plan, command: string, args: string[]): Promise<string> {
  const child = spawnIncusExec(runtimePlan, command, args, { HOME: '/home/node' }, { user: '1000', group: '1000' });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => (stdout += chunk.toString()));
  child.stderr?.on('data', (chunk) => (stderr += chunk.toString()));
  return await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`Guest exited ${code}. stdout=${stdout} stderr=${stderr}`)),
    );
  });
}

function cleanup(assertRemoved: boolean): void {
  // Security assertions run before this disposable-project teardown begins.
  for (const { plan: runtimePlan } of runtimeResources) {
    try {
      const snapshots = JSON.parse(
        execFileSync(
          'incus',
          ['snapshot', 'list', runtimePlan.instance, '--project', runtimePlan.project, '--format', 'json'],
          { encoding: 'utf8', timeout: 30_000 },
        ),
      ) as Array<{ name?: string }>;
      for (const snapshot of snapshots) {
        if (typeof snapshot.name !== 'string') continue;
        execFileSync(
          'incus',
          ['snapshot', 'delete', runtimePlan.instance, snapshot.name, '--project', runtimePlan.project],
          { stdio: 'ignore', timeout: 60_000 },
        );
      }
    } catch (error) {
      console.warn(`VM containment snapshot cleanup failed for ${runtimePlan.instance}`, error);
    }
  }
  const commands = [
    ...runtimeResources.flatMap(({ plan: runtimePlan, transport: runtimeTransport }) => [
      ['delete', runtimePlan.instance, '--project', runtimePlan.project, '--force'],
      ...runtimeTransport.volumes.map((volume) => [
        'storage',
        'volume',
        'delete',
        pool,
        volume.name,
        '--project',
        runtimePlan.project,
      ]),
    ]),
    ['network', 'delete', network],
    ['network', 'acl', 'delete', acl],
  ];
  for (const argv of commands) {
    try {
      execFileSync('incus', argv, { stdio: 'ignore', timeout: 60_000 });
    } catch (error) {
      console.warn(`VM containment cleanup command failed: incus ${argv.join(' ')}`, error);
    }
  }
  const deleteProject = ['project', 'delete', plan.project, '--force'];
  // Incus deliberately prompts even with --force; confirm without attaching an interactive terminal.
  try {
    execFileSync('incus', deleteProject, {
      input: 'yes\n',
      stdio: ['pipe', 'ignore', 'pipe'],
      timeout: 60_000,
    });
  } catch (error) {
    console.warn(`VM containment cleanup command failed: incus ${deleteProject.join(' ')}`, error);
  }
  try {
    execFileSync('incus', ['project', 'show', plan.project], { stdio: 'ignore', timeout: 30_000 });
    if (assertRemoved) throw new Error(`VM containment cleanup left project ${plan.project}`);
    console.warn(`VM containment cleanup left project ${plan.project} after the primary failure`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('VM containment cleanup left project')) throw error;
  }
}
