import { execFileSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { IncusRuntimePlan } from './incus-runtime.js';
import { buildIncusVmDiskPlan } from './incus-vm-disk.js';
import { buildIncusVmNetworkPlan } from './incus-vm-network.js';

export interface IncusCommandResult {
  argv: string[];
  ok: boolean;
  output?: string;
  error?: unknown;
}

export type IncusExecutor = (argv: string[]) => string | void;

export interface IncusAdapterOptions {
  executor?: IncusExecutor;
}

export interface IncusQuarantineOptions extends IncusAdapterOptions {
  reason?: string;
  now?: Date;
}

export interface IncusExecOptions {
  env?: Record<string, string>;
  user?: string;
  group?: string;
}

export interface IncusAdapterResult {
  commands: IncusCommandResult[];
}

export function ensureIncusAvailable(options: IncusAdapterOptions = {}): IncusAdapterResult {
  return runCommands([['version']], options);
}

/** Verify that the guest can execute the Area51 agent runner. */
export function ensureIncusRuntimeReady(plan: IncusRuntimePlan, options: IncusAdapterOptions = {}): IncusAdapterResult {
  validatePlan(plan);
  return runCommands(
    [
      ['exec', plan.instance, '--project', plan.project, '--', 'test', '-x', '/usr/local/bin/bun'],
      ['exec', plan.instance, '--project', plan.project, '--', 'test', '-d', '/app/node_modules'],
    ],
    options,
  );
}

export function applyIncusRuntimePlan(plan: IncusRuntimePlan, options: IncusAdapterOptions = {}): IncusAdapterResult {
  validatePlan(plan);
  prepareNestedMountTargets(plan);

  const vmNetwork = plan.vmNetwork ? buildIncusVmNetworkPlan(plan.vmNetwork) : undefined;
  const vmDisks = plan.vmDisks ? buildIncusVmDiskPlan(plan.vmDisks) : undefined;

  const hostIdentity = writableMountHostIdentity(plan);

  const commands: string[][] = [
    [
      'project',
      'create',
      plan.project,
      ...(plan.instanceKind === 'vm'
        ? ['--config', 'features.networks=false', '--config', 'features.storage.volumes=true']
        : []),
    ],
    ['project', 'set', plan.project, 'restricted=true'],
    ['project', 'set', plan.project, 'limits.instances=3'],
    ['project', 'set', plan.project, 'restricted.devices.disk=allow'],
    ['project', 'set', plan.project, `restricted.devices.disk.paths=${allowedDiskPaths(plan)}`],
  ];
  if (hostIdentity) {
    commands.push(
      ['project', 'set', plan.project, 'restricted.containers.lowlevel=allow'],
      ['project', 'set', plan.project, `restricted.idmap.uid=${hostIdentity.uid}`],
      ['project', 'set', plan.project, `restricted.idmap.gid=${hostIdentity.gid}`],
    );
  }
  if (plan.gatewayProxy) {
    commands.push(['project', 'set', plan.project, 'restricted.devices.proxy=allow']);
  }
  if (vmNetwork) {
    commands.push(
      ...vmNetwork.prepareCommands,
      ['project', 'set', plan.project, 'restricted.devices.nic=allow'],
      ['project', 'set', plan.project, `restricted.networks=${vmNetwork.network}`],
    );
  }
  if (vmDisks) commands.push(...vmDisks.prepareCommands);
  const rootDiskPool = process.env.AREA51_INCUS_STORAGE_POOL;
  if (rootDiskPool) {
    commands.push([
      'profile',
      'device',
      'add',
      'default',
      'root',
      'disk',
      'path=/',
      `pool=${rootDiskPool}`,
      '--project',
      plan.project,
    ]);
  }

  for (const profile of plan.profiles.filter((profile) => profile !== 'default')) {
    commands.push(['profile', 'create', profile, '--project', plan.project]);
    if (profile.includes('net')) {
      commands.push(['profile', 'set', profile, 'security.idmap.isolated=true', '--project', plan.project]);
    }
  }

  const init = ['init', plan.image, plan.instance, '--project', plan.project];
  if (plan.instanceKind === 'vm') init.push('--vm');
  for (const profile of plan.profiles) init.push('--profile', profile);
  commands.push(init);
  if (vmNetwork) commands.push(...vmNetwork.attachCommands);
  if (vmDisks) commands.push(...vmDisks.attachCommands);

  for (const [key, value] of Object.entries(plan.restrictions)) {
    commands.push(['config', 'set', plan.instance, `${key}=${value}`, '--project', plan.project]);
  }
  if (hostIdentity) {
    commands.push([
      'config',
      'set',
      plan.instance,
      `raw.idmap=uid ${hostIdentity.uid} 1000\ngid ${hostIdentity.gid} 1000`,
      '--project',
      plan.project,
    ]);
  }

  for (const mount of plan.mounts) {
    const device = mountDeviceName(mount.path);
    const argv = [
      'config',
      'device',
      'add',
      plan.instance,
      device,
      'disk',
      `source=${mount.source}`,
      `path=${mount.path}`,
      '--project',
      plan.project,
    ];
    if (mount.readonly) argv.splice(8, 0, 'readonly=true');
    commands.push(argv);
  }
  if (plan.gatewayProxy) {
    commands.push([
      'config',
      'device',
      'add',
      plan.instance,
      'onecli-gateway',
      'proxy',
      `listen=${plan.gatewayProxy.listen}`,
      `connect=${plan.gatewayProxy.connect}`,
      'bind=instance',
      '--project',
      plan.project,
    ]);
  }
  commands.push(['start', plan.instance, '--project', plan.project]);

  return runCommands(commands, options);
}

function writableMountHostIdentity(plan: IncusRuntimePlan): { uid: number; gid: number } | undefined {
  if (!plan.mounts.some((mount) => !mount.readonly)) return undefined;
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid == null || gid == null || uid <= 0 || gid <= 0) {
    throw new Error('Incus writable mounts require an unprivileged host UID/GID for a narrow raw.idmap');
  }
  return { uid, gid };
}

export function quarantineIncusInstance(
  plan: IncusRuntimePlan,
  options: IncusQuarantineOptions = {},
): IncusAdapterResult {
  validatePlan(plan);

  const reason = sanitizeConfigValue(options.reason ?? 'agent-gate-risk');
  const quarantineProfile = plan.commands.quarantine
    .map((command) => command.match(/profile add \S+ (\S+) --project/)?.[1])
    .find(Boolean);
  const normalProfiles = plan.profiles.filter((profile) => profile !== 'default');
  const snapshot = `area51-quarantine-${(options.now ?? new Date()).toISOString().replace(/[:.]/g, '-')}`;

  const commands: string[][] = [
    ['freeze', plan.instance, '--project', plan.project],
    ['snapshot', plan.instance, snapshot, '--project', plan.project],
    ...normalProfiles.map((profile) => ['profile', 'remove', plan.instance, profile, '--project', plan.project]),
  ];
  if (quarantineProfile) commands.push(['profile', 'add', plan.instance, quarantineProfile, '--project', plan.project]);
  commands.push(['config', 'set', plan.instance, `user.area51.quarantine_reason=${reason}`, '--project', plan.project]);

  return runCommands(commands, options);
}

export function spawnIncusExec(
  plan: IncusRuntimePlan,
  command: string,
  args: string[],
  env: Record<string, string> = {},
  options: IncusExecOptions = {},
): ChildProcess {
  validatePlan(plan);
  const incusArgs = ['exec', plan.instance, '--project', plan.project];
  const mergedEnv = { ...env, ...(options.env ?? {}) };
  for (const [key, value] of Object.entries(mergedEnv)) {
    incusArgs.push('--env', `${key}=${value}`);
  }
  if (options.user) incusArgs.push('--user', options.user);
  if (options.group) incusArgs.push('--group', options.group);
  incusArgs.push('--', command, ...args);
  return spawn('incus', incusArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
}

export function stopIncusInstance(plan: IncusRuntimePlan, options: IncusAdapterOptions = {}): IncusAdapterResult {
  validatePlan(plan);
  return runCommands([['stop', plan.instance, '--project', plan.project, '--force']], options);
}

function runCommands(commands: string[][], options: IncusAdapterOptions): IncusAdapterResult {
  const executor = options.executor ?? defaultExecutor;
  const results: IncusCommandResult[] = [];
  for (const argv of commands) {
    try {
      const output = executor(argv);
      results.push({ argv, ok: true, output: typeof output === 'string' ? output : undefined });
    } catch (error) {
      if (isAlreadyExists(argv, error)) {
        results.push({ argv, ok: true, output: 'already exists' });
        continue;
      }
      if (argv[0] === 'start' && isAlreadyRunningError(error)) {
        results.push({ argv, ok: true, output: 'already running' });
        continue;
      }
      results.push({ argv, ok: false, error });
      throw new Error(`Incus command failed: incus ${argv.join(' ')}`, { cause: error });
    }
  }
  return { commands: results };
}

function defaultExecutor(argv: string[]): string {
  return execFileSync('incus', argv, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30000,
  });
}

function validatePlan(plan: IncusRuntimePlan): void {
  assertSafeName(plan.project, 'project');
  assertSafeName(plan.instance, 'instance');
  for (const profile of plan.profiles) assertSafeName(profile, 'profile');
  validateMounts(plan);
  validateVmBoundary(plan);
  if (plan.gatewayProxy) {
    assertSafeProxyEndpoint(plan.gatewayProxy.listen, 'listen');
    assertSafeProxyEndpoint(plan.gatewayProxy.connect, 'connect');
  }
}

function validateVmBoundary(plan: IncusRuntimePlan): void {
  if (plan.instanceKind !== 'vm') return;
  if (plan.mounts.length > 0) {
    throw new Error('Incus VM host-path mounts are forbidden; use managed VM disks');
  }
  if (plan.gatewayProxy) {
    throw new Error('Incus VM OneCLI proxying requires a dedicated NIC and deny-by-default ACL');
  }
  if (!plan.vmNetwork) throw new Error('Incus VM plan requires a deny-by-default managed network');
  if (!plan.vmDisks) throw new Error('Incus VM plan requires managed disk transport');
  if (plan.vmNetwork.project !== plan.project || plan.vmNetwork.instance !== plan.instance) {
    throw new Error('Incus VM network scope must match its runtime plan');
  }
  if (plan.vmDisks.project !== plan.project || plan.vmDisks.instance !== plan.instance) {
    throw new Error('Incus VM disk scope must match its runtime plan');
  }
}

function assertSafeProxyEndpoint(value: string, label: string): void {
  if (!/^tcp:(127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/.test(value)) {
    throw new Error(`Unsafe Incus gateway proxy ${label}: ${value}`);
  }
  const port = Number(value.slice(value.lastIndexOf(':') + 1));
  if (port > 65535) throw new Error(`Unsafe Incus gateway proxy ${label}: ${value}`);
}

function assertSafeName(value: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(value)) {
    throw new Error(`Invalid Incus ${label} name: ${value}`);
  }
}

function mountDeviceName(containerPath: string): string {
  return containerPath.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mount';
}

function allowedDiskPaths(plan: IncusRuntimePlan): string {
  return [...new Set(plan.mounts.map((mount) => path.resolve(mount.source)))].join(',');
}

function sanitizeConfigValue(value: string): string {
  return value.replace(/[\r\n]/g, ' ').slice(0, 200);
}

function isAlreadyExistsError(error: unknown): boolean {
  const text =
    error instanceof Error
      ? `${error.message}\n${String((error as { stderr?: unknown }).stderr ?? '')}`
      : String(error);
  return /already exists/i.test(text);
}

function isAlreadyExists(argv: string[], error: unknown): boolean {
  if (!isAlreadyExistsError(error)) return false;
  if ((argv[0] === 'project' || argv[0] === 'profile') && argv[1] === 'create') return true;
  if (argv[0] === 'network' && argv[1] === 'create') return true;
  if (argv[0] === 'network' && argv[1] === 'acl' && argv[2] === 'create') return true;
  if (argv[0] === 'storage' && argv[1] === 'volume' && argv[2] === 'create') return true;
  if (argv[0] === 'profile' && argv[1] === 'device' && argv[2] === 'add') return true;
  if (argv[0] === 'init') return true;
  return argv[0] === 'config' && argv[1] === 'device' && argv[2] === 'add';
}

function isAlreadyRunningError(error: unknown): boolean {
  const text =
    error instanceof Error
      ? `${error.message}\n${String((error as { stderr?: unknown }).stderr ?? '')}`
      : String(error);
  return /already running/i.test(text);
}

function validateMounts(plan: IncusRuntimePlan): void {
  const seenTargets = new Set<string>();
  for (const mount of plan.mounts) {
    const source = normalizeHostPath(mount.source);
    const target = normalizeContainerPath(mount.path);

    if (seenTargets.has(target)) {
      throw new Error(`Duplicate Incus mount target: ${mount.path}`);
    }
    seenTargets.add(target);

    if (!target.startsWith('/')) {
      throw new Error(`Invalid Incus mount target: ${mount.path}`);
    }
    if (target === '/' || target.includes('/../') || target.endsWith('/..')) {
      throw new Error(`Dangerous Incus mount target: ${mount.path}`);
    }
    if (!mount.readonly && target !== '/workspace') {
      throw new Error(`Writable Incus mount target is not allowed: ${mount.path}`);
    }
    if (isDangerousHostMount(source)) {
      throw new Error(`Dangerous Incus host mount denied: ${mount.source}`);
    }
  }
}

function prepareNestedMountTargets(plan: IncusRuntimePlan): void {
  const writableParents = plan.mounts
    .filter((mount) => !mount.readonly)
    .map((mount) => ({ ...mount, target: normalizeContainerPath(mount.path) }))
    .sort((a, b) => b.target.length - a.target.length);

  for (const mount of plan.mounts.filter((candidate) => candidate.readonly)) {
    const target = normalizeContainerPath(mount.path);
    const parent = writableParents.find(
      (candidate) => target !== candidate.target && target.startsWith(`${candidate.target}/`),
    );
    if (!parent) continue;
    if (!fs.existsSync(parent.source) || !fs.existsSync(mount.source)) continue;

    const relativeTarget = target.slice(parent.target.length + 1);
    const hostTarget = path.join(parent.source, ...relativeTarget.split('/'));
    const sourceStats = fs.statSync(mount.source);
    if (sourceStats.isDirectory()) {
      fs.mkdirSync(hostTarget, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(hostTarget), { recursive: true });
      if (!fs.existsSync(hostTarget)) fs.closeSync(fs.openSync(hostTarget, 'w'));
    }
  }
}

function normalizeHostPath(value: string): string {
  return path.resolve(value).replace(/\\/g, '/').toLowerCase();
}

function normalizeContainerPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function isDangerousHostMount(source: string): boolean {
  const root = path.parse(source).root.replace(/\\/g, '/').toLowerCase();
  if (source === root || source === normalizeHostPath(os.homedir())) return true;

  const normalized = source.replace(/\/+/g, '/');
  const parts = normalized.split('/');
  const blockedParts = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.gcloud', '.kube', '.docker', '.config/area51']);
  for (const part of parts) {
    if (blockedParts.has(part)) return true;
  }

  return (
    normalized.includes('/.config/area51') ||
    normalized.endsWith('/docker.sock') ||
    normalized.endsWith('/podman.sock') ||
    normalized.endsWith('/incus/unix.socket') ||
    normalized.endsWith('/lxd/unix.socket') ||
    normalized.includes('/var/lib/incus/unix.socket') ||
    normalized.includes('/var/snap/lxd/common/lxd/unix.socket')
  );
}
