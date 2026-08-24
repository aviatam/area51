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
  vmAgentRetryAttempts?: number;
  vmAgentRetryDelayMs?: number;
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

interface IncusListEntry {
  name?: unknown;
  project?: unknown;
  config?: unknown;
  expanded_config?: unknown;
}

export function ensureIncusAvailable(options: IncusAdapterOptions = {}): IncusAdapterResult {
  return runCommands([['version']], options);
}

/** Verify that the guest can execute the Area51 agent runner. */
export function ensureIncusRuntimeReady(plan: IncusRuntimePlan, options: IncusAdapterOptions = {}): IncusAdapterResult {
  validatePlan(plan);
  const commands = [
    ['exec', plan.instance, '--project', plan.project, '--', 'test', '-x', '/usr/local/bin/bun'],
    ['exec', plan.instance, '--project', plan.project, '--', 'test', '-d', '/app/node_modules'],
  ];
  if (plan.vmNetwork) {
    commands.push([
      'exec',
      plan.instance,
      '--project',
      plan.project,
      '--',
      'bash',
      '-lc',
      `exec 3<>/dev/tcp/${plan.vmNetwork.oneCliAddress}/${plan.vmNetwork.oneCliPort}`,
    ]);
  }
  return runCommands(commands, options);
}

export function applyIncusRuntimePlan(plan: IncusRuntimePlan, options: IncusAdapterOptions = {}): IncusAdapterResult {
  validatePlan(plan);
  prepareNestedMountTargets(plan);

  const vmNetwork = plan.vmNetwork ? buildIncusVmNetworkPlan(plan.vmNetwork) : undefined;
  const vmDisks = plan.vmDisks ? buildIncusVmDiskPlan(plan.vmDisks) : undefined;

  const hostIdentity = writableMountHostIdentity(plan);

  const commands: string[][] = [];
  if (plan.instanceKind === 'vm') {
    commands.push(['storage', 'volume', 'file', 'push', '--help']);
  }
  commands.push(
    [
      'project',
      'create',
      plan.project,
      ...(plan.instanceKind === 'vm'
        ? [
            '--config',
            'features.images=false',
            '--config',
            'features.networks=false',
            '--config',
            'features.storage.volumes=true',
          ]
        : []),
    ],
    ['project', 'set', plan.project, 'restricted=true'],
    ['project', 'set', plan.project, 'limits.instances=3'],
    ['project', 'set', plan.project, 'restricted.devices.disk=allow'],
    ['project', 'set', plan.project, `restricted.devices.disk.paths=${allowedDiskPaths(plan)}`],
  );
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
    commands.push(...vmNetwork.prepareCommands, ['project', 'set', plan.project, 'restricted.devices.nic=managed']);
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
  if (plan.vmFiles) {
    for (const file of plan.vmFiles) {
      commands.push([
        'file',
        'push',
        '--create-dirs',
        '--no-dereference',
        '--uid',
        '0',
        '--gid',
        '0',
        '--mode',
        '0444',
        file.source,
        `${plan.instance}${file.path}`,
        '--project',
        plan.project,
      ]);
    }
  }
  if (vmDisks) commands.push(...vmDisks.initializeCommands);

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

/** Delete a normal runtime and its per-session VM volumes. Quarantine callers must not use this path. */
export function deleteIncusRuntime(plan: IncusRuntimePlan, options: IncusAdapterOptions = {}): IncusAdapterResult {
  validatePlan(plan);
  return runCommands(
    [
      ['delete', plan.instance, '--force', '--project', plan.project],
      ...(plan.vmDisks?.volumes.map((volume) => [
        'storage',
        'volume',
        'delete',
        plan.vmDisks!.pool,
        volume.name,
        '--project',
        plan.project,
      ]) ?? []),
    ],
    options,
  );
}

/** Reap only resources stamped by this installation, preserving quarantined evidence. */
export function cleanupIncusOrphans(installSlug: string, options: IncusAdapterOptions = {}): IncusAdapterResult {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(installSlug)) throw new Error(`Invalid Area51 install slug: ${installSlug}`);
  const executor = options.executor ?? defaultExecutor;
  const output = executor(['list', '--all-projects', '--format=json']);
  const entries = parseIncusList(typeof output === 'string' ? output : '[]');
  const commands: string[][] = [];
  for (const entry of entries) {
    const config = { ...(objectRecord(entry.config) ?? {}), ...(objectRecord(entry.expanded_config) ?? {}) };
    if (
      config['user.area51.install'] !== installSlug ||
      'user.area51.quarantine_reason' in config ||
      config['user.area51.quarantined'] === 'true'
    ) {
      continue;
    }
    if (typeof entry.name !== 'string' || typeof entry.project !== 'string') continue;
    assertSafeName(entry.name, 'instance');
    assertSafeName(entry.project, 'project');
    commands.push(['delete', entry.name, '--force', '--project', entry.project]);
    for (const volume of parseManagedVolumes(config['user.area51.vm_volumes'])) {
      commands.push(['storage', 'volume', 'delete', volume.pool, volume.name, '--project', entry.project]);
    }
  }
  return runCommands(commands, { ...options, executor });
}

function runCommands(commands: string[][], options: IncusAdapterOptions): IncusAdapterResult {
  const executor = options.executor ?? defaultExecutor;
  const results: IncusCommandResult[] = [];
  for (const argv of commands) {
    const maxAttempts = Math.max(1, options.vmAgentRetryAttempts ?? 60);
    for (let attempt = 1; ; attempt += 1) {
      try {
        const output = executor(argv);
        results.push({ argv, ok: true, output: typeof output === 'string' ? output : undefined });
        break;
      } catch (error) {
        if (isVmAgentUnavailable(argv, error) && attempt < maxAttempts) {
          sleepSync(Math.max(0, options.vmAgentRetryDelayMs ?? 2000));
          continue;
        }
        if (isAlreadyExists(argv, error)) {
          results.push({ argv, ok: true, output: 'already exists' });
          break;
        }
        if (argv[0] === 'start' && isAlreadyRunningError(error)) {
          results.push({ argv, ok: true, output: 'already running' });
          break;
        }
        if (isAlreadyAbsent(argv, error)) {
          results.push({ argv, ok: true, output: 'already absent' });
          break;
        }
        results.push({ argv, ok: false, error });
        throw new Error(`Incus command failed: incus ${argv.join(' ')}`, { cause: error });
      }
    }
  }
  return { commands: results };
}

function parseIncusList(value: string): IncusListEntry[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error('expected an array');
    return parsed.filter((entry): entry is IncusListEntry => Boolean(entry) && typeof entry === 'object');
  } catch (error) {
    throw new Error('Invalid Incus instance list response', { cause: error });
  }
}

function objectRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function parseManagedVolumes(value: string | undefined): Array<{ pool: string; name: string }> {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error('expected an array');
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') throw new Error('expected a volume object');
      const pool = (entry as { pool?: unknown }).pool;
      const name = (entry as { name?: unknown }).name;
      if (typeof pool !== 'string' || typeof name !== 'string') throw new Error('expected volume pool and name');
      assertSafeName(pool, 'storage pool');
      assertSafeName(name, 'volume');
      return [{ pool, name }];
    });
  } catch (error) {
    throw new Error('Invalid Area51 managed volume metadata', { cause: error });
  }
}

function isAlreadyAbsent(argv: string[], error: unknown): boolean {
  if (argv[0] !== 'delete' && !(argv[0] === 'storage' && argv[1] === 'volume' && argv[2] === 'delete')) return false;
  return /not found|does not exist|doesn't exist/i.test(errorText(error));
}

function isVmAgentUnavailable(argv: string[], error: unknown): boolean {
  if (argv[0] !== 'exec' && !(argv[0] === 'file' && argv[1] === 'push')) return false;
  return /VM agent isn't currently running/i.test(errorText(error));
}

function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
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
  for (const file of plan.vmFiles ?? []) {
    validateVmFile(file.source, file.path);
  }
  if (plan.vmNetwork.project !== plan.project || plan.vmNetwork.instance !== plan.instance) {
    throw new Error('Incus VM network scope must match its runtime plan');
  }
  if (plan.vmDisks.project !== plan.project || plan.vmDisks.instance !== plan.instance) {
    throw new Error('Incus VM disk scope must match its runtime plan');
  }
}

function validateVmFile(source: string, target: string): void {
  if (!path.isAbsolute(source) || !fs.existsSync(source) || !fs.lstatSync(source).isFile()) {
    throw new Error(`Incus VM bootstrap source must be an existing regular file: ${source}`);
  }
  const normalized = path.posix.normalize(target.replace(/\\/g, '/'));
  if (!normalized.startsWith('/') || normalized === '/' || target.split('/').includes('..')) {
    throw new Error(`Dangerous Incus VM bootstrap target: ${target}`);
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
  return /already exists/i.test(errorText(error));
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? `${error.message}\n${String((error as { stderr?: unknown }).stderr ?? '')}`
    : String(error);
}

function isAlreadyExists(argv: string[], error: unknown): boolean {
  if (!isAlreadyExistsError(error)) return false;
  if ((argv[0] === 'project' || argv[0] === 'profile') && argv[1] === 'create') return true;
  if (argv[0] === 'network' && argv[1] === 'create') return true;
  if (argv[0] === 'network' && argv[1] === 'acl' && argv[2] === 'create') return true;
  if (argv[0] === 'network' && argv[1] === 'acl' && argv[2] === 'rule' && argv[3] === 'add') return true;
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
