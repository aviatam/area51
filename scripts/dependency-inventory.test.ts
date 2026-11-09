import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { importReviewedDependencyInventory, parseInventoryImportArgs } from './dependency-inventory.js';

const roots: string[] = [];
function fixture(name = 'requirements.txt', content = 'requests==2.32.5\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-inventory-import-'));
  roots.push(root);
  const groupDir = path.join(root, 'group');
  fs.mkdirSync(groupDir);
  const source = path.join(root, name);
  fs.writeFileSync(source, content);
  return {
    source,
    groupDir,
    recordDir: path.join(root, 'host-records'),
    runtimeId: 'first-agent',
    imageId: `sha256:${'a'.repeat(64)}`,
    reviewed: true,
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('copies reviewed bytes exactly and records operator provenance without pretending to measure a runtime', () => {
  const options = fixture();
  const now = new Date('2026-11-09T12:00:00Z');
  const record = importReviewedDependencyInventory({ ...options, now });
  expect(fs.readFileSync(record.inventory_file, 'utf8')).toBe('requests==2.32.5\n');
  expect(record.source_sha256).toBe(createHash('sha256').update('requests==2.32.5\n').digest('hex'));
  expect(record.imported_at).toBe(now.toISOString());
  expect(record.runtime_id_label).toBe('first-agent');
  expect(record.limitations.join(' ')).toContain('not verified binding');
  expect(JSON.parse(fs.readFileSync(record.record_path, 'utf8')).source_sha256).toBe(record.source_sha256);
  expect(path.relative(options.groupDir, record.record_path)).toMatch(/^\.\./);
});

it('refuses to replace a previous inventory or discard its evidence', () => {
  const options = fixture();
  const record = importReviewedDependencyInventory(options);
  fs.writeFileSync(options.source, 'requests==2.19.1\n');
  expect(() => importReviewedDependencyInventory(options)).toThrow('already exists');
  expect(fs.readFileSync(record.inventory_file, 'utf8')).toBe('requests==2.32.5\n');
});

it.each([
  ['requirements.txt', ''],
  ['requirements.txt', '# comments only\n'],
  ['requirements.txt', 'requests>=2\n'],
  ['requirements.txt', '-r other.txt\n'],
  ['requirements.txt', 'requests @ https://example.test/pkg.whl\n'],
  ['bom.json', '{broken'],
  ['bom.json', '{}'],
  ['package.json', '{"name":"not-a-lockfile"}'],
])('rejects unusable input %s: %s without publishing a snapshot', (name, content) => {
  const options = fixture(name, content);
  expect(() => importReviewedDependencyInventory(options)).toThrow();
  expect(fs.readdirSync(options.groupDir)).toEqual([]);
});

it('requires explicit review, absolute paths and an immutable image label', () => {
  const options = fixture();
  expect(() => importReviewedDependencyInventory({ ...options, reviewed: false })).toThrow('reviewed');
  expect(() => importReviewedDependencyInventory({ ...options, source: 'relative/requirements.txt' })).toThrow(
    'absolute',
  );
  expect(() => importReviewedDependencyInventory({ ...options, imageId: 'latest' })).toThrow('immutable');
  expect(() => importReviewedDependencyInventory({ ...options, recordDir: options.groupDir })).toThrow('outside');
  expect(fs.readdirSync(options.groupDir)).toEqual([]);
});

it('rejects oversized source files before copying', () => {
  const options = fixture('requirements.txt', 'x'.repeat(2_000_001));
  expect(() => importReviewedDependencyInventory(options)).toThrow('bounded');
  expect(fs.readdirSync(options.groupDir)).toEqual([]);
});

it.skipIf(process.platform === 'win32')('rejects symlink source and group paths', () => {
  const options = fixture();
  const link = path.join(path.dirname(options.source), 'requirements.lock');
  fs.symlinkSync(options.source, link);
  expect(() => importReviewedDependencyInventory({ ...options, source: link })).toThrow('regular');
  const groupLink = options.groupDir + '-link';
  fs.symlinkSync(options.groupDir, groupLink);
  expect(() => importReviewedDependencyInventory({ ...options, groupDir: groupLink })).toThrow('real directory');
});

it('accepts explicit CLI arguments and rejects duplicate, missing or unknown options', () => {
  const options = fixture();
  const args = [
    '--source',
    options.source,
    '--group-dir',
    options.groupDir,
    '--runtime-id',
    options.runtimeId,
    '--image-id',
    options.imageId,
    '--record-dir',
    options.recordDir,
    '--reviewed',
  ];
  expect(parseInventoryImportArgs(args)).toEqual(options);
  expect(() => parseInventoryImportArgs([...args, '--reviewed'])).toThrow('Duplicate');
  expect(() => parseInventoryImportArgs([...args, '--force'])).toThrow();
  expect(() => parseInventoryImportArgs(['--reviewed'])).toThrow('Missing');
});
