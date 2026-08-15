/**
 * Live Incus E2E smoke test.
 *
 * This intentionally talks to a real Incus daemon. It proves the adapter can
 * create an isolated project/instance, attach the hardened mount set, execute
 * a command inside the guest, write only to the session workspace, and clean up.
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
const image = process.env.AREA51_INCUS_E2E_IMAGE || 'images:alpine/3.20';

fs.mkdirSync(groupDir, { recursive: true });
fs.mkdirSync(sessionDir, { recursive: true });
fs.writeFileSync(path.join(groupDir, 'agent.txt'), 'agent-definition\n');
fs.writeFileSync(path.join(sessionDir, 'in.txt'), 'session-input\n');

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

  const result = await runGuest(
    plan,
    'set -eu\n' +
      'test -r /workspace/agent/agent.txt\n' +
      'test -r /workspace/in.txt\n' +
      'echo session-ok > /workspace/result.txt\n' +
      'if echo forbidden > /workspace/agent/should-not-write 2>/tmp/ro.err; then\n' +
      '  echo "agent definition mount was writable" >&2\n' +
      '  exit 42\n' +
      'fi\n' +
      'test -f /workspace/result.txt\n' +
      'echo incus-live-e2e-ok',
  );

  if (!result.stdout.includes('incus-live-e2e-ok')) {
    throw new Error(`Guest did not report success. stdout=${result.stdout} stderr=${result.stderr}`);
  }
  if (fs.readFileSync(path.join(sessionDir, 'result.txt'), 'utf8').trim() !== 'session-ok') {
    throw new Error('Guest write did not land in the session workspace.');
  }
  if (fs.existsSync(path.join(groupDir, 'should-not-write'))) {
    throw new Error('Guest wrote into the read-only agent definition mount.');
  }

  console.log('Live Incus E2E passed.');
} finally {
  cleanup(plan, applied);
  fs.rmSync(root, { recursive: true, force: true });
}

function longRunningIncus(argv: string[]): string {
  return execFileSync('incus', argv, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 240_000,
  });
}

function runGuest(plan: IncusRuntimePlan, script: string): Promise<{ stdout: string; stderr: string }> {
  const child = spawnIncusExec(plan, 'sh', ['-lc', script]);
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
