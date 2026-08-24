/** Live Incus VM disk, network, host-isolation, and cleanup containment test. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { applyIncusRuntimePlan, spawnIncusExec } from '../src/incus-adapter.js';
import { ensureSchema, insertMessage, openInboundDb, openOutboundDb } from '../src/db/session-db.js';
import { buildIncusRuntimePlan } from '../src/incus-runtime.js';
import { buildIncusVmRuntimeTransport } from '../src/incus-vm-runtime.js';
import { syncIncusVmInbound, syncIncusVmOutbound } from '../src/incus-vm-session-bridge.js';

const suffix = (process.env.GITHUB_RUN_ID ?? String(Date.now())).replace(/[^0-9]/g, '').slice(-12);
const image = process.env.AREA51_INCUS_VM_IMAGE_ALIAS;
const pool = process.env.AREA51_INCUS_STORAGE_POOL ?? 'default';
if (!image) throw new Error('AREA51_INCUS_VM_IMAGE_ALIAS is required');

const relayAddress = '10.251.0.1';
const relayPort = 10255;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-vm-e2e-'));
const sessionDir = path.join(root, 'session');
const groupDir = path.join(root, 'group');
fs.mkdirSync(sessionDir);
fs.mkdirSync(groupDir);
fs.writeFileSync(path.join(sessionDir, 'input.txt'), 'session-input\n');
fs.writeFileSync(path.join(groupDir, 'agent.txt'), 'agent-definition\n');
fs.symlinkSync('/app/CLAUDE.md', path.join(groupDir, '.claude-shared.md'));
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

const transport = buildIncusVmRuntimeTransport(
  [
    { source: sessionDir, path: '/workspace', readonly: false },
    { source: groupDir, path: '/workspace/agent', readonly: true },
    { source: bootstrapFile, path: '/run/area51/bootstrap.txt', readonly: true },
    { source: roundtripScript, path: '/run/area51/roundtrip.ts', readonly: true },
  ],
  `vm-e2e-${suffix}`,
);
const network = `vme${suffix}`;
const acl = `vm-acl-${suffix}`;
const plan = buildIncusRuntimePlan({
  agentGroupFolder: `vm-e2e-${suffix}`,
  groupDir,
  mounts: [],
  instanceKind: 'vm',
  instanceSuffix: suffix,
  image: `local:${image}`,
  vmNetwork: {
    network,
    acl,
    ipv4Cidr: `${relayAddress}/24`,
    oneCliAddress: relayAddress,
    oneCliPort: relayPort,
  },
  vmDisks: {
    pool,
    volumes: transport.volumes,
  },
  vmFiles: transport.files,
});

let relay: net.Server | undefined;
let primaryFailure: unknown;
try {
  process.env.AREA51_INCUS_STORAGE_POOL = pool;
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

  console.log('Live Incus VM containment and two-message database round-trip E2E passed.');
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

  const child = spawnIncusExec(plan, 'bash', ['-lc', script], {}, { user: '1000', group: '1000' });
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
  const commands = [
    ['delete', plan.instance, '--project', plan.project, '--force'],
    ...transport.volumes.map((volume) => ['storage', 'volume', 'delete', pool, volume.name, '--project', plan.project]),
    ['network', 'delete', network],
    ['network', 'acl', 'delete', acl],
    ['project', 'delete', plan.project],
  ];
  for (const argv of commands) {
    try {
      execFileSync('incus', argv, { stdio: 'ignore', timeout: 60_000 });
    } catch (error) {
      console.warn(`VM containment cleanup command failed: incus ${argv.join(' ')}`, error);
    }
  }
  try {
    execFileSync('incus', ['project', 'show', plan.project], { stdio: 'ignore', timeout: 30_000 });
    if (assertRemoved) throw new Error(`VM containment cleanup left project ${plan.project}`);
    console.warn(`VM containment cleanup left project ${plan.project} after the primary failure`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('VM containment cleanup left project')) throw error;
  }
}
