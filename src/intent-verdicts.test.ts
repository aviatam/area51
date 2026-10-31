import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { scanAgentGate } from './agent-gate.js';
import {
  checkIntentVerdicts,
  collectIntentCoordinates,
  prepareIntentRuntime,
  resolveIntentConfig,
} from './intent-verdicts.js';
import { selectRuntimePolicy } from './runtime-policy.js';

const ENV = { AREA51_INTENT_API_URL: 'http://127.0.0.1:18080/', AREA51_INTENT_TOKEN: 'intent_tok_test' };

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'area51-intent-'));
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function seedGroup(): string {
  const groupDir = tempDir();
  fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), 'You are a support agent.');
  fs.writeFileSync(path.join(groupDir, 'security-policy.md'), 'Ask before acting.');
  writeJson(path.join(groupDir, 'package-lock.json'), {
    lockfileVersion: 3,
    packages: {
      '': { name: 'agent' },
      'node_modules/@area51-demo/json-fast-format': { version: '1.4.2' },
      'node_modules/@area51-demo/clean-logger': { version: '2.0.0' },
    },
  });
  return groupDir;
}

type Item = { ecosystem: string; name: string; version: string };

function fakeIntent(decide: (item: Item) => Record<string, unknown>): { fetchImpl: typeof fetch; calls: unknown[] } {
  const calls: unknown[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { items: Item[] };
    calls.push({ url, auth: (init.headers as Record<string, string>).authorization, body });
    return new Response(
      JSON.stringify({
        config_version: 'builtin-1',
        results: body.items.map((item) => ({ coordinate: item, ...decide(item) })),
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const maliciousOrClean = (item: Item): Record<string, unknown> =>
  item.name.endsWith('json-fast-format')
    ? {
        status: 'available',
        analysis_id: '01J',
        verdict: {
          top_severity: 'critical',
          findings: [
            { title: 'Sensitive file access', severity: 'critical' },
            { title: 'Persistence write', severity: 'high' },
            { title: 'DNS lookup', severity: 'low' },
          ],
        },
        decision: { action: 'block', reason: 'severity critical ≥ block threshold' },
      }
    : { status: 'available', verdict: { top_severity: 'none', findings: [] }, decision: { action: 'allow' } };

describe('resolveIntentConfig', () => {
  it('is off without both URL and token, and fails closed by default', () => {
    expect(resolveIntentConfig({})).toBeNull();
    expect(resolveIntentConfig({ AREA51_INTENT_API_URL: 'http://x' })).toBeNull();
    expect(resolveIntentConfig(ENV)).toEqual({
      apiUrl: 'http://127.0.0.1:18080',
      token: 'intent_tok_test',
      mode: 'required',
      waitMs: 10000,
    });
  });
});

describe('collectIntentCoordinates', () => {
  it('reads exact pins from lockfile, container.json, package.json and requirements, skipping ranges', () => {
    const groupDir = seedGroup();
    writeJson(path.join(groupDir, 'container.json'), { packages: { npm: ['@scope/tool@3.1.0', 'unpinned'] } });
    writeJson(path.join(groupDir, 'package.json'), { dependencies: { exact: '1.0.0', ranged: '^2.0.0' } });
    fs.writeFileSync(path.join(groupDir, 'requirements.txt'), 'requests==2.32.3\nflask>=3\n');

    const names = collectIntentCoordinates(groupDir).map((c) => `${c.ecosystem}:${c.name}@${c.version}:${c.source}`);
    expect(names).toEqual([
      'npm:@area51-demo/json-fast-format@1.4.2:package-lock.json',
      'npm:@area51-demo/clean-logger@2.0.0:package-lock.json',
      'npm:@scope/tool@3.1.0:container.json',
      'npm:exact@1.0.0:package.json',
      'pypi:requests@2.32.3:requirements.txt',
    ]);
  });
});

describe('checkIntentVerdicts', () => {
  it('is disabled (open-source mode) and never calls out without configuration', async () => {
    const { fetchImpl, calls } = fakeIntent(maliciousOrClean);
    const result = await checkIntentVerdicts(seedGroup(), { env: {}, fetchImpl });
    expect(result.summary.status).toBe('disabled');
    expect(result.findings).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('turns a behavioral block into a dependency finding and allows the clean package', async () => {
    const { fetchImpl, calls } = fakeIntent(maliciousOrClean);
    const result = await checkIntentVerdicts(seedGroup(), { env: ENV, fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'http://127.0.0.1:18080/v1/verdicts:batch',
      auth: 'Bearer intent_tok_test',
    });
    expect(result.summary.status).toBe('complete');
    expect(result.summary.packages.map((p) => p.status)).toEqual(['blocked', 'allowed']);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ severity: 'high', pillar: 'security' });
    expect(result.findings[0].id).toMatch(/^dependency-intent-[0-9a-f]{16}$/);
    expect(result.findings[0].detail).toContain('Sensitive file access; Persistence write');
    expect(result.findings[0].detail).not.toContain('DNS lookup');
  });

  it('fails closed when Intent is unreachable or still analyzing', async () => {
    const down = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const unreachable = await checkIntentVerdicts(seedGroup(), { env: ENV, fetchImpl: down });
    expect(unreachable.summary.status).toBe('incomplete');
    expect(unreachable.findings.map((f) => [f.id, f.severity])).toEqual([
      ['dependency-intent-unverified-unavailable', 'high'],
    ]);

    const { fetchImpl } = fakeIntent(() => ({ status: 'pending', analysis_id: '01P' }));
    const pending = await checkIntentVerdicts(seedGroup(), { env: ENV, fetchImpl });
    expect(pending.findings).toHaveLength(2);
    expect(pending.findings.every((f) => f.id.startsWith('dependency-intent-unverified-'))).toBe(true);

    const advisory = await checkIntentVerdicts(seedGroup(), {
      env: { ...ENV, AREA51_INTENT_MODE: 'advisory' },
      fetchImpl,
    });
    expect(advisory.findings.every((f) => f.severity === 'warning' && f.id.startsWith('intent-'))).toBe(true);
  });

  it('rejects a response that does not answer the coordinates asked', async () => {
    const { fetchImpl } = fakeIntent(() => ({
      coordinate: { ecosystem: 'npm', name: 'other', version: '1.0.0' },
      status: 'available',
      decision: { action: 'allow' },
    }));
    const result = await checkIntentVerdicts(seedGroup(), { env: ENV, fetchImpl });
    expect(result.summary.packages.every((p) => p.status === 'error')).toBe(true);
    expect(result.findings).toHaveLength(2);
  });
});

describe('Agent Gate with Mend Intent', () => {
  it('passes a zero-day package without Intent and quarantines it with Intent', async () => {
    const groupDir = seedGroup();
    const { fetchImpl } = fakeIntent(maliciousOrClean);
    const base = { groupDir, env: { ANTHROPIC_API_KEY: 'x' }, quarantine: false };

    const oss = await scanAgentGate({ ...base, intent: { env: {} } });
    expect(oss.findings.some((f) => f.id.startsWith('dependency-'))).toBe(false);
    expect(oss.intent?.status).toBe('disabled');

    const both = await scanAgentGate({ ...base, intent: { env: ENV, fetchImpl } });
    expect(both.passed).toBe(false);
    const decision = selectRuntimePolicy(both, { profile: 'production', incusAvailable: true });
    expect(decision.action).toBe('quarantine');
    expect(decision.quarantineRequired).toBe(true);
  });
});

describe('prepareIntentRuntime', () => {
  it('stages the shim as npm/npx and points the container at the host API', () => {
    const dataDir = tempDir();
    const shim = path.join(dataDir, 'intent-linux');
    fs.writeFileSync(shim, '#!/bin/sh\n');
    expect(prepareIntentRuntime(dataDir, {})).toBeNull();
    expect(prepareIntentRuntime(dataDir, ENV)).toBeNull();

    const runtime = prepareIntentRuntime(dataDir, { ...ENV, AREA51_INTENT_SHIM: shim })!;
    expect(fs.readlinkSync(path.join(runtime.hostDir, 'bin', 'npm'))).toBe('intent');
    expect(runtime.env).toMatchObject({
      INTENT_API_URL: 'http://host.docker.internal:18080',
      INTENT_TOKEN: 'intent_tok_test',
      INTENT_NON_REGISTRY: 'block',
    });
    expect(runtime.env.PATH.startsWith('/opt/intent/bin:')).toBe(true);
    expect(() => prepareIntentRuntime(dataDir, { ...ENV, AREA51_INTENT_SHIM: '/nope' })).toThrow(/not a file/);
  });
});
