import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildReport,
  readBaseline,
  SCHEMA,
  writeBaseline,
  writeReport,
  type Baseline,
  type HostState,
} from '../scripts/verify.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-reboot-'));
  roots.push(value);
  return value;
}

const baseline: Baseline = {
  schema: 'area51.linux_reboot_baseline.v1',
  recorded_at: '2026-09-09T00:00:00.000Z',
  boot_id: '11111111-1111-1111-1111-111111111111',
  commit_sha: 'a'.repeat(40),
};

function healthyState(overrides: Partial<HostState> = {}): HostState {
  return {
    baselineBootId: baseline.boot_id,
    currentBootId: '22222222-2222-2222-2222-222222222222',
    incusActive: true,
    egressActive: true,
    area51Active: true,
    containerImageReady: true,
    vmImageReady: true,
    governanceEvidenceValid: true,
    checkoutClean: true,
    commitUnchanged: true,
    ...overrides,
  };
}

describe('Linux physical reboot evidence', () => {
  it('passes only when the boot changed and every production check is healthy', () => {
    const report = buildReport(healthyState(), new Date('2026-09-09T00:01:00.000Z'));
    expect(report).toMatchObject({ schema: SCHEMA, passed: true, kernel_boot_changed: true });
    expect(report.cases).toHaveLength(9);
    expect(report.cases.every((testCase) => testCase.passed)).toBe(true);
  });

  it('does not mistake a service restart for a physical reboot', () => {
    const report = buildReport(healthyState({ currentBootId: baseline.boot_id }));
    expect(report.passed).toBe(false);
    expect(report.kernel_boot_changed).toBe(false);
    expect(report.cases.find((testCase) => testCase.id === 'boot-id-changed')?.passed).toBe(false);
  });

  it.each([
    'incusActive',
    'egressActive',
    'area51Active',
    'containerImageReady',
    'vmImageReady',
    'governanceEvidenceValid',
    'checkoutClean',
    'commitUnchanged',
  ] as const)('fails when %s is unhealthy', (field) => {
    expect(buildReport(healthyState({ [field]: false })).passed).toBe(false);
  });

  it('writes private baseline and report evidence and refuses silent baseline replacement', () => {
    const directory = root();
    const baselinePath = writeBaseline(directory, baseline);
    expect(readBaseline(directory)).toEqual(baseline);
    expect(() => writeBaseline(directory, baseline)).toThrow('already exists');

    const reportPath = writeReport(directory, buildReport(healthyState()));
    expect(JSON.parse(fs.readFileSync(reportPath, 'utf8'))).toMatchObject({ passed: true });
    if (process.platform !== 'win32') {
      expect(fs.statSync(baselinePath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(reportPath).mode & 0o777).toBe(0o600);
    }
  });

  it('fails on an invalid current boot ID', () => {
    expect(buildReport(healthyState({ currentBootId: '' })).passed).toBe(false);
  });

  it('rejects malformed baseline evidence', () => {
    const directory = root();
    const target = path.join(directory, '.area51', 'reboot-verification', 'baseline.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ ...baseline, boot_id: '../not-a-boot-id' }));
    expect(() => readBaseline(directory)).toThrow('invalid reboot baseline');
  });
});
