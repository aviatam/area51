import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ensureDependencyScanner } from './dependency-scanner.js';

vi.mock('./dependency-security-pins.json', async () => {
  const { createHash } = await import('node:crypto');
  return {
    default: {
      version: '2.7.0',
      assets: {
        [`${process.platform}-${process.arch}`]: {
          name: 'osv-scanner-test',
          sha256: createHash('sha256').update('reviewed-test-binary').digest('hex'),
        },
      },
    },
  };
});
const roots: string[] = [];
function temp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-scanner-test-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('automatically downloads only the pinned release, deduplicates provisioning and rechecks existing bytes', async () => {
  vi.stubEnv('AREA51_DEPENDENCY_SCANNER', undefined);
  const fetch = vi.fn().mockResolvedValue(new Response('reviewed-test-binary'));
  vi.stubGlobal('fetch', fetch);
  const root = temp();
  const [a, b] = await Promise.all([ensureDependencyScanner(root), ensureDependencyScanner(root)]);
  expect(a).toBe(b);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe(
    'https://github.com/google/osv-scanner/releases/download/v2.7.0/osv-scanner-test',
  );
  expect(fs.readFileSync(a, 'utf8')).toBe('reviewed-test-binary');
  expect(await ensureDependencyScanner(root)).toBe(a);
  fs.writeFileSync(a, 'tampered');
  await expect(ensureDependencyScanner(root)).rejects.toThrow('integrity');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('rejects altered download bytes without publishing a binary', async () => {
  vi.stubEnv('AREA51_DEPENDENCY_SCANNER', undefined);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('untrusted')));
  const root = temp();
  await expect(ensureDependencyScanner(root)).rejects.toThrow('checksum');
  expect(fs.readdirSync(root)).toEqual([]);
});

it('does not download over an explicitly configured missing binary', async () => {
  vi.stubEnv('AREA51_DEPENDENCY_SCANNER', path.join(temp(), 'missing'));
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(ensureDependencyScanner()).rejects.toThrow('missing');
  expect(fetch).not.toHaveBeenCalled();
});
