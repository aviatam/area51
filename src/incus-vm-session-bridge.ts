import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { IncusRuntimePlan } from './incus-runtime.js';

const GUEST_BRIDGE = '/app/src/vm-db-bridge.ts';
const GUEST_STAGE = '/run/area51-sync';

export type IncusBridgeExecutor = (argv: string[]) => string | void;

export interface IncusVmSessionBridgeOptions {
  executor?: IncusBridgeExecutor;
}

/** Merge the latest host-owned inbound database into the live VM database. */
export function syncIncusVmInbound(
  plan: IncusRuntimePlan,
  hostSessionDir: string,
  options: IncusVmSessionBridgeOptions = {},
): void {
  assertVmPlan(plan);
  const source = path.join(hostSessionDir, 'inbound.db');
  if (!fs.statSync(source).isFile()) throw new Error(`Incus VM inbound database is missing: ${source}`);

  const snapshot = path.join(hostSessionDir, `.inbound.area51-sync-${process.pid}.db`);
  try {
    // The host is the sole inbound writer and all writes run on this event
    // loop. A synchronous copy therefore captures a complete DELETE-journal
    // database before it crosses into the guest.
    fs.copyFileSync(source, snapshot);
    run(
      [
        'file',
        'push',
        '--create-dirs',
        '--uid',
        '0',
        '--gid',
        '0',
        '--mode',
        '0600',
        snapshot,
        `${plan.instance}${GUEST_STAGE}/inbound.db`,
        '--project',
        plan.project,
      ],
      options,
    );
    run(
      ['exec', plan.instance, '--project', plan.project, '--', 'bun', 'run', GUEST_BRIDGE, 'import-inbound'],
      options,
    );
  } finally {
    fs.rmSync(snapshot, { force: true });
  }
}

/** Replace the host read replica with a consistent guest-owned outbound snapshot. */
export function syncIncusVmOutbound(
  plan: IncusRuntimePlan,
  hostSessionDir: string,
  options: IncusVmSessionBridgeOptions = {},
): void {
  assertVmPlan(plan);
  const destination = path.join(hostSessionDir, 'outbound.db');
  const snapshot = path.join(hostSessionDir, `.outbound.area51-sync-${process.pid}.db`);
  const heartbeatSnapshot = path.join(hostSessionDir, `.heartbeat.area51-sync-${process.pid}`);
  try {
    fs.rmSync(snapshot, { force: true });
    fs.rmSync(heartbeatSnapshot, { force: true });
    run(
      ['exec', plan.instance, '--project', plan.project, '--', 'bun', 'run', GUEST_BRIDGE, 'export-outbound'],
      options,
    );
    run(['file', 'pull', `${plan.instance}${GUEST_STAGE}/outbound.db`, snapshot, '--project', plan.project], options);
    run(
      ['file', 'pull', `${plan.instance}${GUEST_STAGE}/heartbeat`, heartbeatSnapshot, '--project', plan.project],
      options,
    );
    if (!fs.statSync(snapshot).isFile()) throw new Error('Incus VM outbound snapshot was not pulled');
    if (!fs.statSync(heartbeatSnapshot).isFile()) throw new Error('Incus VM heartbeat metadata was not pulled');
    fs.renameSync(snapshot, destination);
    installHeartbeat(heartbeatSnapshot, path.join(hostSessionDir, '.heartbeat'));
  } finally {
    fs.rmSync(snapshot, { force: true });
    fs.rmSync(heartbeatSnapshot, { force: true });
  }
}

function run(argv: string[], options: IncusVmSessionBridgeOptions): string | void {
  return (options.executor ?? defaultExecutor)(argv);
}

function defaultExecutor(argv: string[]): string {
  return execFileSync('incus', argv, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
}

function assertVmPlan(plan: IncusRuntimePlan): void {
  if (plan.instanceKind !== 'vm' || !plan.vmDisks) {
    throw new Error('Incus VM session synchronization requires a managed-volume VM plan');
  }
}

function installHeartbeat(snapshot: string, destination: string): void {
  const value = fs.readFileSync(snapshot, 'utf8').trim();
  if (value === 'missing') return;
  if (!/^\d+$/.test(value)) throw new Error('Incus VM returned invalid heartbeat metadata');
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > Date.now() + 60_000) {
    throw new Error('Incus VM returned an invalid heartbeat timestamp');
  }
  if (!fs.existsSync(destination)) fs.writeFileSync(destination, '');
  const date = new Date(timestamp);
  fs.utimesSync(destination, date, date);
}
