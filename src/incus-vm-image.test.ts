import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const script = fs.readFileSync(path.join(process.cwd(), 'container', 'incus', 'build-vm.sh'), 'utf8');
const workflow = fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'incus-vm-image.yml'), 'utf8');

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

  it('probes nested KVM on a disposable GitHub-hosted runner', () => {
    expect(workflow).toContain('runs-on: ubuntu-latest');
    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain("grep -E -m1 '(vmx|svm)' /proc/cpuinfo");
    expect(workflow).toContain('test -e /dev/kvm');
    expect(workflow).toContain('sudo chmod 0666 /dev/kvm');
    expect(workflow).toContain('test -r /dev/kvm');
    expect(workflow).toContain('sudo apt-get install -y incus acl qemu-system-x86');
    expect(workflow).toContain('sudo incus admin init --minimal');
    expect(workflow).toContain('incus profile device remove default eth0');
    expect(workflow.indexOf('incus profile device remove default eth0')).toBeLessThan(
      workflow.indexOf('incus profile device add default eth0'),
    );
    expect(workflow).not.toContain('self-hosted');
  });
});
