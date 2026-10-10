import { expect, it } from 'vitest';
import { assertSeparateRecoveryRunners, identifyRecoveryRunner } from './recovery-runner-identity.js';

const input = {
  machineId: 'a'.repeat(32),
  bootId: '11111111-1111-1111-1111-111111111111',
  hostname: 'runner-source',
  environment: 'github-hosted',
  job: 'vm-image',
};
const source = identifyRecoveryRunner(input);
const target = identifyRecoveryRunner({
  ...input,
  bootId: '22222222-2222-2222-2222-222222222222',
  hostname: 'runner-target',
  job: 'clean-host-recovery',
});
it('accepts separate hosted boot instances sharing an image machine ID', () => {
  expect(source.machineId).toBe(target.machineId);
  expect(() => assertSeparateRecoveryRunners(source, target)).not.toThrow();
});
it('rejects the same boot even after hostname and machine ID change', () => {
  expect(() =>
    assertSeparateRecoveryRunners(source, { ...target, bootId: source.bootId, machineId: 'c'.repeat(64) }),
  ).toThrow('different Linux boot');
});
it('rejects a different boot with the same hostname', () => {
  expect(() => assertSeparateRecoveryRunners(source, { ...target, hostname: source.hostname })).toThrow(
    'different runner hostname',
  );
});
it.each([
  undefined,
  {},
  { ...source, bootId: '' },
  { ...source, schema: 'old' },
  { ...source, environment: 'self-hosted' },
])('rejects missing, malformed or unsupported source evidence', (invalid) => {
  expect(() => assertSeparateRecoveryRunners(invalid, target)).toThrow();
});
it('rejects the wrong job roles', () => {
  expect(() => assertSeparateRecoveryRunners(target, source)).toThrow();
});
it.each([
  { ...input, bootId: '' },
  { ...input, machineId: '' },
  { ...input, hostname: '' },
  { ...input, environment: 'self-hosted' },
  { ...input, job: 'unknown' },
])('fails closed when required observations are invalid', (invalid) => {
  expect(() => identifyRecoveryRunner(invalid)).toThrow();
});
it('hashes normalized observations and does not expose raw identifiers', () => {
  expect(source.bootId).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(source)).not.toContain(input.hostname);
  expect(identifyRecoveryRunner({ ...input, machineId: input.machineId.toUpperCase() + '\n' })).toEqual(source);
});
