import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const script = fs.readFileSync(path.join(process.cwd(), 'container', 'incus', 'build-vm.sh'), 'utf8');

describe('Incus VM image builder', () => {
  it('requires KVM and launches the VM image variant', () => {
    expect(script).toContain('[[ ! -e /dev/kvm ]]');
    expect(script).toContain('incus launch "$BASE_IMAGE" "$BUILDER" --vm');
    expect(script).toContain('Incus guest agent did not become ready');
  });

  it('bakes the runner into the VM instead of relying on host mounts', () => {
    expect(script).toContain('agent-runner/src');
    expect(script).toContain('"$BUILDER/app/"');
    expect(script).toContain('test -f /app/src/index.ts');
    expect(script).toContain('/etc/area51/image-kind');
  });

  it('uses a distinct alias and refuses destructive replacement', () => {
    expect(script).toContain('AREA51_INCUS_VM_IMAGE_ALIAS:-area51-agent-v2-vm');
    expect(script).toContain('already exists; delete or rename it explicitly before rebuilding');
    expect(script).not.toContain('incus image delete "$ALIAS"');
  });

  it('strips setuid bits before publishing', () => {
    expect(script).toContain('find / -xdev -perm -4000 -type f -exec chmod u-s {} +');
    expect(script).toContain('incus publish "$BUILDER" --alias "$ALIAS"');
  });
});
