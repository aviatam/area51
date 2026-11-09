/** Import an operator-reviewed resolved inventory. Never executes a package manager or guest. */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageDependencyFiles } from '../src/dependency-security.js';
const MAX_BYTES = 2_000_000;

export interface InventoryImportOptions {
  source: string;
  groupDir: string;
  runtimeId: string;
  imageId: string;
  reviewed: boolean;
  recordDir?: string;
  now?: Date;
}

/** The record describes operator assertions and source bytes, not runtime attestation. */
export function importReviewedDependencyInventory(options: InventoryImportOptions) {
  if (!options.reviewed) throw new Error('Explicit --reviewed acknowledgement is required');
  if (!path.isAbsolute(options.source) || !path.isAbsolute(options.groupDir))
    throw new Error('Source and group directory must be absolute paths');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(options.runtimeId)) throw new Error('Invalid runtime ID label');
  if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(options.imageId))
    throw new Error('Image ID must be an immutable SHA-256 label');
  const source = path.resolve(options.source),
    groupDir = path.resolve(options.groupDir);
  const recordDir = path.resolve(options.recordDir ?? 'data/dependency-inventory-imports');
  if (options.recordDir && !path.isAbsolute(options.recordDir)) throw new Error('Record directory must be absolute');
  const recordRelative = path.relative(groupDir, recordDir);
  if (
    !recordRelative ||
    (!recordRelative.startsWith('..' + path.sep) && recordRelative !== '..' && !path.isAbsolute(recordRelative))
  )
    throw new Error('Audit records must remain outside the group');
  if (fs.lstatSync(groupDir).isSymbolicLink() || !fs.lstatSync(groupDir).isDirectory())
    throw new Error('Group directory must be an existing real directory');
  const name = path.basename(source);
  const initial = fs.lstatSync(source);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size === 0 || initial.size > MAX_BYTES)
    throw new Error('Inventory must be a nonempty bounded regular file');
  const fd = fs.openSync(
    source,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
  );
  let bytes: Buffer;
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino || opened.size > MAX_BYTES)
      throw new Error('Inventory changed while opening');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const read = fs.readSync(fd, buffer, total, buffer.length - total, null);
      if (!read) break;
      total += read;
    }
    bytes = buffer.subarray(0, total);
  } finally {
    fs.closeSync(fd);
  }
  if (!bytes.length || bytes.length > MAX_BYTES || !bytes.toString('utf8').trim())
    throw new Error('Empty or oversized inventory');
  if (name.endsWith('.json')) {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length)
      throw new Error('Inventory JSON must be a nonempty object');
  }
  const validationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-inventory-validation-'));
  try {
    const input = path.join(validationDir, 'input');
    fs.mkdirSync(input);
    const output = path.join(validationDir, 'output');
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(input, name), bytes, { mode: 0o600, flag: 'wx' });
    if (stageDependencyFiles(input, output).length !== 1) throw new Error('Unsupported inventory filename');
    if (
      (name === 'requirements.txt' || name === 'requirements.lock') &&
      !bytes
        .toString('utf8')
        .split(/\r?\n/)
        .some((line) => line.trim() && !/^\s*(?:#|--hash=)/.test(line))
    )
      throw new Error('Requirements contain no pinned packages');
  } finally {
    fs.rmSync(validationDir, { recursive: true, force: true });
  }
  const destination = path.join(groupDir, 'dependency-inventory');
  if (fs.existsSync(destination) || fs.lstatSync(groupDir).isSymbolicLink())
    throw new Error('Inventory destination already exists; preserve and archive it outside the group before replacing');
  const temporary = fs.mkdtempSync(path.join(groupDir, '.inventory-import-'));
  const id = randomUUID();
  const recordPath = path.join(recordDir, `${id}.json`);
  const record = {
    schema: 'area51.reviewed_inventory_import.v1',
    id,
    imported_at: (options.now ?? new Date()).toISOString(),
    record_path: recordPath,
    runtime_id_label: options.runtimeId,
    image_id_label: options.imageId,
    source_filename: name,
    source_sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    inventory_file: path.join(destination, name),
    operator_reviewed: true,
    validation:
      'Bounds, JSON syntax and exact requirements pins only; the mandatory dependency scan must validate parser coverage and package identities.',
    limitations: [
      'Operator-reviewed bootstrap snapshot; not collected from a guest or image by this command.',
      'Runtime/image labels are operator assertions, not verified binding or installed-package attestation.',
      'Does not monitor changes, prove complete coverage, authenticate package bytes, release holds or start an agent.',
    ],
  };
  try {
    fs.chmodSync(temporary, 0o700);
    fs.writeFileSync(path.join(temporary, name), bytes, { mode: 0o600, flag: 'wx' });
    fs.mkdirSync(recordDir, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(recordDir).isSymbolicLink() || !fs.lstatSync(recordDir).isDirectory())
      throw new Error('Audit directory must be a real host directory');
    // This private record may remain as an audit of an attempt if publication fails.
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    // Publish the complete single-file snapshot, without overwriting previous evidence.
    if (fs.existsSync(destination)) throw new Error('Inventory destination appeared during import');
    fs.renameSync(temporary, destination);
    return record;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export function parseInventoryImportArgs(args: string[]): InventoryImportOptions {
  const values: Record<string, string> = {};
  let reviewed = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--reviewed') {
      if (reviewed) throw new Error('Duplicate --reviewed');
      reviewed = true;
      continue;
    }
    if (
      !['--source', '--group-dir', '--runtime-id', '--image-id', '--record-dir'].includes(flag) ||
      flag in values ||
      !args[i + 1] ||
      args[i + 1].startsWith('--')
    )
      throw new Error(
        'Use --source ABSOLUTE_FILE --group-dir ABSOLUTE_GROUP --runtime-id ID --image-id SHA256 --reviewed',
      );
    values[flag] = args[++i];
  }
  if (['--source', '--group-dir', '--runtime-id', '--image-id'].some((flag) => !values[flag]))
    throw new Error('Missing required inventory import arguments');
  return {
    source: values['--source'],
    groupDir: values['--group-dir'],
    runtimeId: values['--runtime-id'],
    imageId: values['--image-id'],
    ...(values['--record-dir'] ? { recordDir: values['--record-dir'] } : {}),
    reviewed,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(
      JSON.stringify(importReviewedDependencyInventory(parseInventoryImportArgs(process.argv.slice(2))), null, 2),
    );
  } catch {
    console.error(
      'Inventory import failed; no agent was started. Check reviewed source, immutable image label, paths, format and destination.',
    );
    process.exitCode = 1;
  }
}
