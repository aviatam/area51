import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { IncusVmFile } from './incus-runtime.js';
import type { IncusVmVolume } from './incus-vm-disk.js';

export interface IncusVmRuntimeTransport {
  volumes: IncusVmVolume[];
  files: IncusVmFile[];
}

interface RuntimeMount {
  source: string;
  path: string;
  readonly: boolean;
}

/** Translate the host mount contract into VM-native managed disks and bootstrap files. */
export function buildIncusVmRuntimeTransport(mounts: RuntimeMount[], suffix: string): IncusVmRuntimeTransport {
  const volumes: IncusVmVolume[] = [];
  const files: IncusVmFile[] = [];
  const selectedDirectories: RuntimeMount[] = [];
  const targets = new Set<string>();

  for (const mount of [...mounts].sort((a, b) => a.path.length - b.path.length)) {
    const target = normalizeGuestPath(mount.path);
    if (target === '/app' || target.startsWith('/app/')) continue;
    if (targets.has(target)) continue;

    const stats = fs.lstatSync(mount.source);
    const covering = selectedDirectories
      .filter((parent) => isDescendant(target, parent.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (covering && sourceMatchesParent(mount.source, target, covering)) continue;

    if (stats.isDirectory()) {
      selectedDirectories.push({ ...mount, path: target });
      targets.add(target);
      volumes.push({
        name: volumeName(suffix, volumes.length + 1),
        source: mount.source,
        path: target,
        readonly: mount.readonly,
        size: target === '/workspace' ? '2GiB' : '256MiB',
      });
      continue;
    }
    if (!stats.isFile()) throw new Error(`Unsupported Incus VM runtime source type: ${mount.source}`);
    if (!mount.readonly) throw new Error(`Writable Incus VM file mounts are forbidden: ${target}`);
    if (covering?.readonly) {
      throw new Error(`Incus VM file override inside a read-only managed volume is unsupported: ${target}`);
    }
    targets.add(target);
    files.push({ source: mount.source, path: target, readonly: true });
  }

  if (!volumes.some((volume) => volume.path === '/workspace' && !volume.readonly)) {
    throw new Error('Incus VM runtime requires a writable /workspace managed volume');
  }
  return { volumes, files };
}

function normalizeGuestPath(value: string): string {
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  if (!normalized.startsWith('/') || normalized === '/' || value.split('/').includes('..')) {
    throw new Error(`Dangerous Incus VM runtime target: ${value}`);
  }
  return normalized;
}

function isDescendant(target: string, parent: string): boolean {
  return target.startsWith(`${parent}/`);
}

function sourceMatchesParent(source: string, target: string, parent: RuntimeMount): boolean {
  const relative = path.posix.relative(parent.path, target);
  return path.resolve(source) === path.resolve(parent.source, ...relative.split('/'));
}

function volumeName(suffix: string, index: number): string {
  const safe = suffix
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!safe) throw new Error(`Invalid Incus VM volume suffix: ${suffix}`);
  const digest = createHash('sha256').update(suffix).digest('hex').slice(0, 8);
  return `a51-${safe.slice(0, 35)}-${digest}-${index}`;
}
