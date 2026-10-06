import fs from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(fs.readFileSync(new URL('../.github/workflows/incus-vm-image.yml', import.meta.url), 'utf8'));
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
