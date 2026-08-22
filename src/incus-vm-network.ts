import { isIP } from 'node:net';

export interface IncusVmNetworkOptions {
  project: string;
  instance: string;
  network: string;
  acl: string;
  ipv4Cidr: string;
  oneCliAddress: string;
  oneCliPort: number;
}

export interface IncusVmNetworkPlan extends IncusVmNetworkOptions {
  prepareCommands: string[][];
  attachCommands: string[][];
  commands: string[][];
}

/**
 * Build the deny-by-default network contract required before Area51 can run
 * agents in Incus VMs. The bridge has no NAT, IPv6, or DNS; its only explicit
 * egress allowance is the host-side OneCLI relay.
 */
export function buildIncusVmNetworkPlan(options: IncusVmNetworkOptions): IncusVmNetworkPlan {
  validateName(options.project, 'project');
  validateName(options.instance, 'instance');
  validateName(options.network, 'network');
  validateName(options.acl, 'ACL');
  const { address, networkAddress, prefix } = parsePrivateIpv4Cidr(options.ipv4Cidr);
  if (isIP(options.oneCliAddress) !== 4 || !isPrivateIpv4(options.oneCliAddress)) {
    throw new Error(`Incus VM OneCLI address must be private IPv4: ${options.oneCliAddress}`);
  }
  if (!isAddressInCidr(options.oneCliAddress, networkAddress, prefix)) {
    throw new Error(`Incus VM OneCLI address must be inside ${options.ipv4Cidr}`);
  }
  if (options.oneCliAddress !== address) {
    throw new Error('Incus VM OneCLI relay must bind the managed bridge address');
  }
  if (!Number.isInteger(options.oneCliPort) || options.oneCliPort < 1 || options.oneCliPort > 65535) {
    throw new Error(`Invalid Incus VM OneCLI port: ${options.oneCliPort}`);
  }

  const projectArgs = ['--project', options.project];
  const prepareCommands = [
    [
      'network',
      'create',
      options.network,
      `ipv4.address=${options.ipv4Cidr}`,
      'ipv4.nat=false',
      'ipv6.address=none',
      'dns.mode=none',
      ...projectArgs,
    ],
    ['network', 'acl', 'create', options.acl, ...projectArgs],
    [
      'network',
      'acl',
      'rule',
      'add',
      options.acl,
      'egress',
      'action=allow',
      `destination=${options.oneCliAddress}/32`,
      'protocol=tcp',
      `destination_port=${options.oneCliPort}`,
      ...projectArgs,
    ],
    [
      'network',
      'set',
      options.network,
      `security.acls=${options.acl}`,
      'security.acls.default.ingress.action=reject',
      'security.acls.default.egress.action=reject',
      ...projectArgs,
    ],
  ];
  const attachCommands = [
    [
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
    ],
  ];
  return { ...options, prepareCommands, attachCommands, commands: [...prepareCommands, ...attachCommands] };
}

function validateName(value: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(value)) {
    throw new Error(`Invalid Incus VM ${label} name: ${value}`);
  }
}

function parsePrivateIpv4Cidr(value: string): { address: string; networkAddress: number; prefix: number } {
  const match = value.match(/^([^/]+)\/(\d{1,2})$/);
  if (!match || isIP(match[1]) !== 4) throw new Error(`Invalid Incus VM IPv4 CIDR: ${value}`);
  const prefix = Number(match[2]);
  if (prefix < 16 || prefix > 30 || !isPrivateIpv4(match[1])) {
    throw new Error(`Incus VM network must use a private IPv4 /16-/30 CIDR: ${value}`);
  }
  const address = ipv4ToNumber(match[1]);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const networkAddress = address & mask;
  const host = address & ~mask;
  if (host === 0 || host === ~mask >>> 0) {
    throw new Error(`Incus VM bridge CIDR must use a host address: ${value}`);
  }
  return { address: match[1], networkAddress, prefix };
}

function isPrivateIpv4(value: string): boolean {
  const octets = value.split('.').map(Number);
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function isAddressInCidr(value: string, networkAddress: number, prefix: number): boolean {
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const address = ipv4ToNumber(value);
  const host = address & ~mask;
  return (address & mask) === networkAddress && host !== 0 && host !== ~mask >>> 0;
}

function ipv4ToNumber(value: string): number {
  return value.split('.').reduce((result, octet) => ((result << 8) | Number(octet)) >>> 0, 0);
}
