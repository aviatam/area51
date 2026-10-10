import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export interface RecoveryRunnerIdentity {
  schema: 'area51.recovery-runner.v1';
  environment: 'github-hosted';
  job: 'vm-image' | 'clean-host-recovery';
  machineId: string;
  bootId: string;
  hostname: string;
}
const hash = (value: string) => createHash('sha256').update(value.trim().toLowerCase()).digest('hex');

/** Trusted CI observations, not hardware attestation or a production host ID. */
export function identifyRecoveryRunner(input: {
  machineId: string;
  bootId: string;
  hostname: string;
  environment: string | undefined;
  job: string | undefined;
}): RecoveryRunnerIdentity {
  assert.equal(input.environment, 'github-hosted', 'Recovery proof requires GitHub-hosted runners');
  assert(input.job === 'vm-image' || input.job === 'clean-host-recovery', 'Unexpected recovery job');
  assert(/^[a-f0-9]{32}$/i.test(input.machineId.trim()), 'Invalid machine ID');
  assert(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.bootId.trim()),
    'Invalid boot ID',
  );
  assert(/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(input.hostname.trim()), 'Invalid hostname');
  return {
    schema: 'area51.recovery-runner.v1',
    environment: 'github-hosted',
    job: input.job,
    machineId: hash(input.machineId),
    bootId: hash(input.bootId),
    hostname: hash(input.hostname),
  };
}

function validate(value: unknown): asserts value is RecoveryRunnerIdentity {
  assert(value && typeof value === 'object', 'Missing runner identity');
  const identity = value as Partial<RecoveryRunnerIdentity>;
  assert.equal(identity.schema, 'area51.recovery-runner.v1');
  assert.equal(identity.environment, 'github-hosted');
  assert(identity.job === 'vm-image' || identity.job === 'clean-host-recovery');
  for (const key of ['machineId', 'bootId', 'hostname'] as const)
    assert(typeof identity[key] === 'string' && /^[a-f0-9]{64}$/.test(identity[key]!), `Invalid ${key} digest`);
}

export function assertSeparateRecoveryRunners(source: unknown, target: unknown): void {
  validate(source);
  validate(target);
  assert.equal(source.job, 'vm-image');
  assert.equal(target.job, 'clean-host-recovery');
  // Hosted images may share machine IDs and hostnames. Keep both diagnostic.
  // A different job alone, or a random token, is not sufficient evidence.
  assert.notEqual(source.bootId, target.bootId, 'Restore must use a different Linux boot instance');
}
