import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { IncusRuntimePlan } from './incus-runtime.js';

const GUEST_BRIDGE = '/app/src/vm-db-bridge.ts';
const GUEST_STAGE = '/run/area51-sync';
const PROVIDER_PATH = '/home/node/.claude';
const MAX_FILES = 2_048;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export type IncusProviderStateExecutor = (argv: string[]) => string | void;

interface ProviderStateManifest {
  version: 1;
  files: Array<{ path: string; size: number; sha256: string }>;
}

/**
 * Persist the writable VM provider state without exposing a host bind mount.
 * Returns false when the plan has no default provider-state volume.
 */
export function syncIncusVmProviderState(
  plan: IncusRuntimePlan,
  options: { executor?: IncusProviderStateExecutor } = {},
): boolean {
  if (plan.instanceKind !== 'vm' || !plan.vmDisks) {
    throw new Error('Incus VM provider-state synchronization requires a managed-volume VM plan');
  }
  const volume = plan.vmDisks.volumes.find((entry) => entry.path === PROVIDER_PATH);
  if (!volume) return false;
  if (volume.readonly) throw new Error('Incus VM provider-state volume must be writable');

  const source = path.resolve(volume.source);
  const parent = path.dirname(source);
  fs.mkdirSync(parent, { recursive: true });
  if (fs.existsSync(source)) {
    const stats = fs.lstatSync(source);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`Unsafe provider-state target: ${source}`);
  }

  const executor = options.executor ?? defaultExecutor;
  const transferRoot = fs.mkdtempSync(path.join(parent, '.area51-provider-state-'));
  const manifestPath = path.join(transferRoot, 'manifest.json');
  const nextState = path.join(transferRoot, 'state');
  fs.mkdirSync(nextState, { mode: 0o700 });
  try {
    executor([
      'exec',
      plan.instance,
      '--project',
      plan.project,
      '--',
      'bun',
      'run',
      GUEST_BRIDGE,
      'export-provider-state',
    ]);
    executor([
      'file',
      'pull',
      `${plan.instance}${GUEST_STAGE}/provider-state.json`,
      manifestPath,
      '--project',
      plan.project,
    ]);
    const manifest = parseManifest(fs.readFileSync(manifestPath, 'utf8'));
    for (const file of manifest.files) {
      const destination = path.join(nextState, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      executor([
        'file',
        'pull',
        `${plan.instance}${GUEST_STAGE}/provider-state/${file.path}`,
        destination,
        '--project',
        plan.project,
      ]);
      const content = fs.readFileSync(destination);
      if (content.byteLength !== file.size || createHash('sha256').update(content).digest('hex') !== file.sha256) {
        throw new Error(`Incus VM provider-state snapshot mismatch: ${file.path}`);
      }
      fs.chmodSync(destination, 0o600);
    }
    installAtomically(nextState, source);
    return true;
  } finally {
    fs.rmSync(transferRoot, { recursive: true, force: true });
  }
}

function parseManifest(value: string): ProviderStateManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('Invalid Incus VM provider-state manifest', { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) {
    throw new Error('Invalid Incus VM provider-state manifest version');
  }
  const rawFiles = (parsed as { files?: unknown }).files;
  if (!Array.isArray(rawFiles) || rawFiles.length > MAX_FILES) {
    throw new Error('Invalid Incus VM provider-state file count');
  }
  const seen = new Set<string>();
  let total = 0;
  const files = rawFiles.map((entry): ProviderStateManifest['files'][number] => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid Incus VM provider-state entry');
    const candidate = entry as { path?: unknown; size?: unknown; sha256?: unknown };
    if (typeof candidate.path !== 'string' || !isSafeRelativePath(candidate.path) || seen.has(candidate.path)) {
      throw new Error('Invalid Incus VM provider-state path');
    }
    if (
      !Number.isSafeInteger(candidate.size) ||
      (candidate.size as number) < 0 ||
      (candidate.size as number) > MAX_FILE_BYTES
    ) {
      throw new Error(`Invalid Incus VM provider-state size: ${candidate.path}`);
    }
    if (typeof candidate.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(candidate.sha256)) {
      throw new Error(`Invalid Incus VM provider-state digest: ${candidate.path}`);
    }
    seen.add(candidate.path);
    total += candidate.size as number;
    if (total > MAX_TOTAL_BYTES) throw new Error('Incus VM provider state exceeds 64 MiB');
    return { path: candidate.path, size: candidate.size as number, sha256: candidate.sha256 };
  });
  return { version: 1, files };
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.length > 512 || value.includes('\\') || value.includes('\0')) return false;
  const parts = value.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function installAtomically(nextState: string, destination: string): void {
  const backup = `${destination}.area51-backup-${process.pid}-${Date.now()}`;
  let backedUp = false;
  try {
    if (fs.existsSync(destination)) {
      fs.renameSync(destination, backup);
      backedUp = true;
    }
    fs.renameSync(nextState, destination);
  } catch (error) {
    if (backedUp && !fs.existsSync(destination)) fs.renameSync(backup, destination);
    throw error;
  }
  if (backedUp) fs.rmSync(backup, { recursive: true, force: true });
}

function defaultExecutor(argv: string[]): string {
  return execFileSync('incus', argv, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
}
