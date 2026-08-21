/**
 * Live Incus E2E hostile containment test.
 *
 * This intentionally talks to a real Incus daemon. It proves the adapter can
 * create an isolated project/instance, attach the hardened mount set, execute
 * a command inside the guest, then fail closed on obvious escape surfaces:
 * writable agent material, host/runtime sockets, privileged capabilities,
 * unexpected network devices, and host paths outside the declared mounts.
 */
import { execFileSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { applyIncusRuntimePlan } from '../src/incus-adapter.js';
import { buildIncusRuntimePlan, type IncusRuntimePlan } from '../src/incus-runtime.js';
import { spawnIncusExec } from '../src/incus-adapter.js';

if (process.platform !== 'linux') {
  console.log('Skipping live Incus E2E: Incus live test requires Linux.');
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-incus-e2e-'));
const groupDir = path.join(root, 'group');
const sessionDir = path.join(root, 'session');
const hostSecretPath = path.join(root, 'host-secret.txt');
const image = process.env.AREA51_INCUS_E2E_IMAGE || 'images:alpine/3.20';

fs.mkdirSync(groupDir, { recursive: true });
fs.mkdirSync(sessionDir, { recursive: true });
fs.writeFileSync(path.join(groupDir, 'agent.txt'), 'agent-definition\n');
fs.writeFileSync(path.join(sessionDir, 'in.txt'), 'session-input\n');
fs.writeFileSync(path.join(sessionDir, 'existing.db'), 'before\n', { mode: 0o600 });
fs.writeFileSync(hostSecretPath, 'host-only-secret\n');

const plan = buildIncusRuntimePlan({
  agentGroupFolder: 'live-e2e',
  groupDir,
  sessionDir,
  image,
  instanceSuffix: String(Date.now()),
});

let applied = false;
try {
  console.log(`Incus version: ${execFileSync('incus', ['version'], { encoding: 'utf8' }).trim()}`);
  console.log(`Launching ${plan.project}/${plan.instance} from ${image}`);

  applyIncusRuntimePlan(plan, { executor: longRunningIncus });
  applied = true;

  const result = await runGuest(plan, hostileGuestScript());

  if (!result.stdout.includes('incus-live-e2e-ok')) {
    throw new Error(`Guest did not report success. stdout=${result.stdout} stderr=${result.stderr}`);
  }
  if (fs.readFileSync(path.join(sessionDir, 'result.txt'), 'utf8').trim() !== 'session-ok') {
    throw new Error('Guest write did not land in the session workspace.');
  }
  if (fs.readFileSync(path.join(sessionDir, 'existing.db'), 'utf8').trim() !== 'after') {
    throw new Error('Guest could not update an existing private session database file.');
  }
  if (fs.existsSync(path.join(groupDir, 'should-not-write'))) {
    throw new Error('Guest wrote into the read-only agent definition mount.');
  }
  if (fs.readFileSync(hostSecretPath, 'utf8') !== 'host-only-secret\n') {
    throw new Error('Guest changed a host file outside the declared mounts.');
  }
  if (fs.existsSync(path.join(root, 'container-root-marker'))) {
    throw new Error('Guest path traversal landed in the host temp root outside the session mount.');
  }

  console.log('Live Incus hostile containment E2E passed.');
} finally {
  cleanup(plan, applied);
  fs.rmSync(root, { recursive: true, force: true });
}

function hostileGuestScript(): string {
  return String.raw`
set -eu

fail() {
  echo "E2E containment failure: $*" >&2
  exit 42
}

expect_missing() {
  for path in "$@"; do
    if [ -e "$path" ]; then
      fail "unexpected host/runtime path is visible: $path"
    fi
  done
}

test -r /workspace/agent/agent.txt || fail "read-only agent material is missing"
test -r /workspace/in.txt || fail "session input is missing"
[ "$(cat /workspace/in.txt)" = "session-input" ] || fail "session input content mismatch"

echo session-ok > /workspace/result.txt
test -f /workspace/result.txt || fail "session workspace write did not persist"
echo after > /workspace/existing.db || fail "existing private session file was not writable"

if echo forbidden > /workspace/agent/should-not-write 2>/tmp/ro.err; then
  fail "agent definition mount was writable"
fi

expect_missing \
  /host-secret.txt \
  /workspace/../host-secret.txt \
  /var/run/docker.sock \
  /run/docker.sock \
  /var/run/podman/podman.sock \
  /run/podman/podman.sock \
  /var/lib/incus/unix.socket \
  /run/incus/unix.socket \
  /var/lib/lxd/unix.socket \
  /run/lxd/unix.socket \
  /var/snap/lxd/common/lxd/unix.socket

if env | grep -E '^(DOCKER_HOST|CONTAINER_HOST|INCUS_|LXD_)=' >/tmp/area51-env-leak.txt 2>/dev/null; then
  cat /tmp/area51-env-leak.txt >&2
  fail "runtime control environment leaked into guest"
fi

cap_eff="$(awk '/^CapEff:/ {print $2}' /proc/self/status)"
[ -n "$cap_eff" ] || fail "could not read effective capabilities"
cap_dec=$((0x$cap_eff))
cap_sys_admin=$((1 << 21))
if [ $((cap_dec & cap_sys_admin)) -ne 0 ]; then
  fail "guest has CAP_SYS_ADMIN"
fi

for iface_path in /sys/class/net/*; do
  [ -e "$iface_path" ] || continue
  iface="$(basename "$iface_path")"
  if [ "$iface" != "lo" ]; then
    fail "unexpected non-loopback network interface: $iface"
  fi
done

if echo container-only > /container-root-marker 2>/tmp/container-root.err; then
  fail "non-root guest process could write to the container root filesystem"
fi
test ! -e /workspace/container-root-marker || fail "container-root marker appeared inside mounted workspace"
test ! -e /workspace/agent/container-root-marker || fail "container-root marker appeared inside agent material"

echo incus-live-e2e-ok
`;
}

function longRunningIncus(argv: string[]): string {
  return execFileSync('incus', argv, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 240_000,
  });
}

function runGuest(plan: IncusRuntimePlan, script: string): Promise<{ stdout: string; stderr: string }> {
  const child = spawnIncusExec(plan, 'sh', ['-lc', script], {}, { user: '1000', group: '1000' });
  return collect(child);
}

function collect(child: ChildProcess): Promise<{ stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Guest command failed with ${code}. stdout=${stdout} stderr=${stderr}`));
      }
    });
  });
}

function cleanup(plan: IncusRuntimePlan, applied: boolean): void {
  if (!applied) return;
  for (const argv of [
    ['delete', plan.instance, '--project', plan.project, '--force'],
    ['project', 'delete', plan.project],
  ]) {
    try {
      execFileSync('incus', argv, { stdio: 'ignore', timeout: 60_000 });
    } catch {
      // Best-effort cleanup. GitHub runners are ephemeral; local output already
      // contains the instance/project names for manual cleanup.
    }
  }
}
