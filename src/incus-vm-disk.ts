import { isAbsolute, normalize, parse, resolve } from 'node:path';

export interface IncusVmVolume {
  name: string;
  source: string;
  path: string;
  readonly: boolean;
  size: string;
}

export interface IncusVmDiskOptions {
  project: string;
  instance: string;
  pool: string;
  volumes: IncusVmVolume[];
}

export interface IncusVmDiskPlan extends IncusVmDiskOptions {
  commands: string[][];
}

const SAFE_WRITABLE_PATHS = new Set(['/workspace', '/workspace/agent', '/home/node/.claude']);

/** Build a VM disk plan that stages host data through Incus-managed volumes. */
export function buildIncusVmDiskPlan(options: IncusVmDiskOptions): IncusVmDiskPlan {
  validateName(options.project, 'project');
  validateName(options.instance, 'instance');
  validateName(options.pool, 'storage pool');
  if (options.volumes.length === 0) throw new Error('Incus VM disk plan requires at least one managed volume');

  const names = new Set<string>();
  const targets = new Set<string>();
  const commands: string[][] = [];

  for (const [index, volume] of options.volumes.entries()) {
    validateName(volume.name, 'volume');
    if (names.has(volume.name)) throw new Error(`Duplicate Incus VM volume name: ${volume.name}`);
    names.add(volume.name);

    const source = validateHostSource(volume.source);
    const target = validateGuestPath(volume.path);
    if (targets.has(target)) throw new Error(`Duplicate Incus VM volume target: ${target}`);
    targets.add(target);
    if (!volume.readonly && !SAFE_WRITABLE_PATHS.has(target)) {
      throw new Error(`Writable Incus VM volume target is not allowed: ${target}`);
    }
    if (!/^\d+(?:\.\d+)?(?:KiB|MiB|GiB|TiB)$/.test(volume.size)) {
      throw new Error(`Invalid Incus VM volume size: ${volume.size}`);
    }

    const projectArgs = ['--project', options.project];
    commands.push(
      [
        'storage',
        'volume',
        'create',
        options.pool,
        volume.name,
        `size=${volume.size}`,
        'initial.uid=1000',
        'initial.gid=1000',
        'initial.mode=0700',
        ...projectArgs,
      ],
      [
        'storage',
        'volume',
        'file',
        'push',
        '--recursive',
        '--no-dereference',
        '--uid',
        '1000',
        '--gid',
        '1000',
        source,
        options.pool,
        `${volume.name}/`,
        ...projectArgs,
      ],
    );

    const device = `area51-disk-${index + 1}`;
    const attach = [
      'config',
      'device',
      'add',
      options.instance,
      device,
      'disk',
      `pool=${options.pool}`,
      `source=${volume.name}`,
      `path=${target}`,
    ];
    if (volume.readonly) attach.push('readonly=true');
    attach.push(...projectArgs);
    commands.push(attach);
  }

  return { ...options, commands };
}

function validateName(value: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(value)) {
    throw new Error(`Invalid Incus VM ${label} name: ${value}`);
  }
}

function validateHostSource(value: string): string {
  if (!isAbsolute(value)) throw new Error(`Incus VM volume source must be absolute: ${value}`);
  const source = resolve(value);
  const root = parse(source).root;
  if (source === root) throw new Error('Incus VM volume source cannot be the host root');
  const normalized = normalize(source).replace(/\\/g, '/').toLowerCase();
  const sensitiveParts = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.gcloud', '.kube', '.docker']);
  if (normalized.split('/').some((part) => sensitiveParts.has(part)) || normalized.includes('/.config/area51')) {
    throw new Error(`Dangerous Incus VM volume source denied: ${value}`);
  }
  if (
    normalized.endsWith('/docker.sock') ||
    normalized.endsWith('/podman.sock') ||
    normalized.endsWith('/incus/unix.socket') ||
    normalized.endsWith('/lxd/unix.socket')
  ) {
    throw new Error(`Dangerous Incus VM volume source denied: ${value}`);
  }
  return source;
}

function validateGuestPath(value: string): string {
  const target = normalize(value).replace(/\\/g, '/');
  if (!target.startsWith('/') || target === '/' || target.includes('/../') || target.endsWith('/..')) {
    throw new Error(`Dangerous Incus VM volume target: ${value}`);
  }
  return target.replace(/\/$/, '');
}
