/** Live Incus VM disk, network, host-isolation, and cleanup containment test. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { applyIncusRuntimePlan, spawnIncusExec } from '../src/incus-adapter.js';
import { buildIncusRuntimePlan } from '../src/incus-runtime.js';
import { buildIncusVmRuntimeTransport } from '../src/incus-vm-runtime.js';

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
const bootstrapFile = path.join(root, 'onecli-bootstrap');
fs.writeFileSync(bootstrapFile, 'onecli-bootstrap\n');

const transport = buildIncusVmRuntimeTransport(
  [
    { source: sessionDir, path: '/workspace', readonly: false },
    { source: groupDir, path: '/workspace/agent', readonly: true },
    { source: bootstrapFile, path: '/run/area51/bootstrap.txt', readonly: true },
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
  console.log('Live Incus VM containment E2E passed.');
} finally {
  relay?.close();
  cleanup();
  fs.rmSync(root, { recursive: true, force: true });
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

function cleanup(): void {
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
    } catch {
      // Continue so a partial setup cannot prevent later cleanup steps.
    }
  }
  try {
    execFileSync('incus', ['project', 'show', plan.project], { stdio: 'ignore', timeout: 30_000 });
    throw new Error(`VM containment cleanup left project ${plan.project}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('VM containment cleanup left project')) throw error;
  }
}
