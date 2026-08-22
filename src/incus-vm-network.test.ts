import { describe, expect, it } from 'vitest';

import { buildIncusVmNetworkPlan } from './incus-vm-network.js';

describe('Incus VM network contract', () => {
  const options = {
    project: 'area51-maximum',
    instance: 'area51-maximum-agent',
    network: 'a51-max-vm-net',
    acl: 'area51-maximum-onecli-only',
    ipv4Cidr: '10.51.0.1/24',
    oneCliAddress: '10.51.0.1',
    oneCliPort: 10255,
  };

  it('builds a non-NAT bridge with DNS and IPv6 disabled', () => {
    const plan = buildIncusVmNetworkPlan(options);

    expect(plan.commands[0]).toEqual([
      'network',
      'create',
      options.network,
      '--type=bridge',
      'ipv4.address=10.51.0.1/24',
      'ipv4.nat=false',
      'ipv6.address=none',
      'dns.mode=none',
      '--project',
      options.project,
    ]);
  });

  it('rejects unmatched ingress and egress and allows only OneCLI', () => {
    const plan = buildIncusVmNetworkPlan(options);

    expect(plan.commands).toContainEqual([
      'network',
      'acl',
      'rule',
      'add',
      options.acl,
      'egress',
      'action=allow',
      'destination=10.51.0.1/32',
      'protocol=tcp',
      'destination_port=10255',
      '--project',
      options.project,
    ]);
    expect(plan.attachCommands).toContainEqual([
      'config',
      'device',
      'add',
      options.instance,
      'area51-vm-net',
      'nic',
      `network=${options.network}`,
      `security.acls=${options.acl}`,
      'security.acls.default.ingress.action=reject',
      'security.acls.default.egress.action=reject',
      '--project',
      options.project,
    ]);
    expect(plan.commands).toContainEqual([
      'network',
      'set',
      options.network,
      `security.acls=${options.acl}`,
      'security.acls.default.ingress.action=reject',
      'security.acls.default.egress.action=reject',
      '--project',
      options.project,
    ]);
  });

  it.each([
    ['public bridge', { ipv4Cidr: '203.0.113.0/24' }],
    ['network-address CIDR', { ipv4Cidr: '10.51.0.0/24' }],
    ['gateway outside bridge', { oneCliAddress: '10.52.0.1' }],
    ['loopback gateway', { oneCliAddress: '127.0.0.1' }],
    ['zero port', { oneCliPort: 0 }],
    ['unsafe network name', { network: 'net;open' }],
    ['long bridge name', { network: 'area51-maximum-vm-net' }],
  ])('fails closed for %s', (_label, override) => {
    expect(() => buildIncusVmNetworkPlan({ ...options, ...override })).toThrow();
  });
});
