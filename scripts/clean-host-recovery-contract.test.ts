import fs from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(fs.readFileSync(new URL('../.github/workflows/incus-vm-image.yml', import.meta.url), 'utf8'));
it('requires v2 runner identity checks before disk import without dropping fresh-Incus checks', () => {
  const source = fs.readFileSync(new URL('./clean-host-recovery-proof.ts', import.meta.url), 'utf8');
  expect(source).toContain("assert.equal(bundle.schema, 'area51.clean_host_bundle.v2')");
  expect(source.indexOf('assertSeparateRecoveryRunners(bundle.sourceRunnerIdentity, runnerIdentity)')).toBeLessThan(
    source.indexOf("incus(['import'"),
  );
  expect(source).toContain("assert.deepEqual(JSON.parse(incus(['list', '--format', 'json'])), [])");
  expect(source).not.toContain('assert.notEqual(bundle.sourceMachine');
});
it('prepares bounded HTTPS package downloads on every disposable native runner', () => {
  for (const name of ['vm-image', 'clean-host-recovery', 'linux-installer']) {
    const steps = workflow.jobs[name].steps;
    const setup = steps.findIndex((step: any) => step.run?.includes('bash scripts/prepare-ci-apt.sh'));
    expect(setup).toBeGreaterThanOrEqual(0);
    const checkout = steps.findIndex((step: any) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout).toBeLessThan(setup);
    const installer = steps.findIndex((step: any) => step.name === 'Run candidate one-command installer');
    if (name === 'linux-installer') expect(setup).toBeLessThan(installer);
  }
});
it('requires a distinct dependent runner for recovery and gates report publication on it', () => {
  expect(workflow.jobs['clean-host-recovery'].needs).toBe('vm-image');
  expect(workflow.jobs['clean-host-recovery']['runs-on']).toBe('ubuntu-latest');
  const report = Object.values(workflow.jobs).find(
    (job: any) => job.name === 'Publish release acceptance report',
  ) as any;
  expect(report.needs).toContain('clean-host-recovery');
});
it('transfers only the dedicated synthetic bundle with short binary retention', () => {
  const steps = workflow.jobs['vm-image'].steps;
  const upload = steps.find((step: any) => step.name === 'Upload synthetic recovery transfer');
  expect(upload.with.path).toBe('.area51/recovery-transfer');
  expect(upload.with['retention-days']).toBe(1);
  expect(upload.with['include-hidden-files']).toBe(true);
  expect(steps.findIndex((step: any) => step.name === 'Upload synthetic recovery transfer')).toBeLessThan(
    steps.findIndex((step: any) => step.name === 'Release verified smoke VM resources'),
  );
});
it('does not rebuild the guest image on the clean restore runner', () => {
  const steps = workflow.jobs['clean-host-recovery'].steps;
  expect(steps.some((step: any) => step.run?.includes('build-vm.sh'))).toBe(false);
  expect(steps.some((step: any) => step.run === 'node --import tsx scripts/clean-host-recovery-proof.ts restore')).toBe(
    true,
  );
});
it('attaches the separately backed-up volume before boot and requires guest shutdown before export', () => {
  const boot = workflow.jobs['vm-image'].steps.find((step: any) => step.name === 'Boot and verify baked runtime').run;
  expect(boot.indexOf('recovery-state disk')).toBeLessThan(boot.indexOf('incus start'));
  const source = fs.readFileSync(new URL('./clean-host-recovery-proof.ts', import.meta.url), 'utf8');
  expect(source).toContain('await stopFromGuest(vm)');
  expect(source).toContain('systemctl poweroff');
  expect(source).toContain('refusing backup');
  expect(source).not.toContain("incus(['stop', vm");
});
it('parses expanded configuration as YAML without an unsupported format flag', () => {
  const source = fs.readFileSync(new URL('./clean-host-recovery-proof.ts', import.meta.url), 'utf8');
  expect(source.match(/parseYaml\(incus\(\['config', 'show', .* '--expanded'\]\)\)/g)).toHaveLength(3);
  expect(source).not.toContain("'--expanded', '--format'");
});
