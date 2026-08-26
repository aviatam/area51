import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const script = fs.readFileSync(path.join(process.cwd(), 'container', 'incus', 'build-vm.sh'), 'utf8');
const workflow = fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'incus-vm-image.yml'), 'utf8');
const containment = fs.readFileSync(path.join(process.cwd(), 'scripts', 'incus-vm-containment-e2e.ts'), 'utf8');

describe('Incus VM image builder', () => {
  it('requires KVM and launches the VM image variant', () => {
    expect(script).toContain('[[ ! -e /dev/kvm ]]');
    expect(script).toContain('incus launch "$BASE_IMAGE" "$BUILDER" --vm');
    expect(script).toContain('-c limits.cpu=2 -c limits.memory=3GiB');
    expect(script).toContain('Incus guest agent did not become ready');
  });

  it('bakes the runner into the VM instead of relying on host mounts', () => {
    expect(script).toContain('agent-runner/src');
    expect(script).toContain('"$BUILDER/app/"');
    expect(script).toContain('export PNPM_HOME=/usr/local/bin');
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
    expect(workflow).toContain('URIs: https://pkgs.zabbly.com/incus/lts-7.0');
    expect(workflow).toContain('sudo apt-get install -y incus acl qemu-system-x86');
    expect(workflow).toContain('incus admin init --minimal');
    expect(workflow).not.toContain('sudo incus admin init --minimal');
    expect(workflow.indexOf('sudo setfacl -m')).toBeLessThan(workflow.indexOf('incus admin init --minimal'));
    expect(workflow).toContain('incus profile device show default');
    expect(workflow).toContain('incus network list');
    expect(workflow).toContain('sudo sysctl -w net.ipv4.ip_forward=1');
    expect(workflow).toContain('sudo iptables -I FORWARD 1 -i incusbr0');
    expect(workflow).toContain('sudo iptables -t nat -I POSTROUTING 1');
    expect(workflow).not.toContain('incus profile device add default eth0');
    expect(workflow).not.toContain('self-hosted');
  });

  it('runs a real VM containment test before VM enablement', () => {
    expect(workflow).toContain('scripts/incus-vm-containment-e2e.ts');
    expect(containment).toContain('applyIncusRuntimePlan(plan');
    expect(containment).toContain('spawnIncusExec(plan');
    expect(containment).toContain('non-relay internet egress succeeded');
    expect(containment).toContain('host control path visible');
    expect(containment).toContain('syncIncusVmInbound(plan, sessionDir)');
    expect(containment).toContain('syncIncusVmOutbound(plan, sessionDir)');
    expect(containment).toContain('area51-vm-roundtrip-ok');
    expect(containment).toContain("'vm-roundtrip-2'");
    expect(containment).toContain("['project', 'delete', plan.project, '--force']");
  });

  it('lets live Runtime Policy select and verify the real Incus VM', () => {
    expect(containment).toContain('selectLiveRuntimePolicy(gateReport');
    expect(containment).toContain('blockedLocalDecision.action');
    expect(containment).toContain('writeLiveRuntimePolicyDecision');
    expect(containment).toContain('enforceIncusRuntimeDecision(runtimeDecision, plan)');
    expect(containment).toContain("liveInstances[0]?.type !== 'virtual-machine'");
    expect(workflow).toContain('src/live-runtime-policy.ts');
    expect(workflow).toContain('src/runtime-policy.ts');
    expect(containment.indexOf('blockedLocalDecision.action')).toBeLessThan(
      containment.indexOf('applyIncusRuntimePlan(plan'),
    );
  });

  it('proves compromised-package quarantine on the live VM', () => {
    expect(containment).toContain('compromisedGateReport(groupDir)');
    expect(containment).toContain("quarantineDecision.action !== 'quarantine'");
    expect(containment).toContain("quarantined?.status?.toLowerCase() !== 'stopped'");
    expect(containment).toContain("expanded_config?.['user.area51.quarantined'] !== 'true'");
    expect(containment).toContain("expanded_devices?.['area51-vm-net']");
    expect(containment).toContain("snapshot.name?.startsWith('area51-quarantine-')");
    expect(containment).toContain('Agent execution remained possible after quarantine');
  });
});
