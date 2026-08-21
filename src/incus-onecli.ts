import fs from 'fs';
import path from 'path';

export interface OneCliContainerConfig {
  env: Record<string, string>;
  caCertificate: string;
  caCertificateContainerPath: string;
  credentialStubs?: Array<{ containerPath: string; content: string }>;
}

export interface IncusOneCliConfig {
  env: Record<string, string>;
  mounts: Array<{ hostPath: string; containerPath: string; readonly: true }>;
}

/** Materialize OneCLI's ephemeral files and point proxy traffic at the guest-local relay. */
export function prepareIncusOneCliConfig(
  config: OneCliContainerConfig,
  rootDir: string,
  proxyHost = '127.0.0.1',
  proxyPort = 10255,
): IncusOneCliConfig {
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(rootDir, 0o700);

  const env = Object.fromEntries(
    Object.entries(config.env).map(([key, value]) => [key, rewriteProxyUrl(key, value, proxyHost, proxyPort)]),
  );
  const mounts: IncusOneCliConfig['mounts'] = [];

  const caPath = path.join(rootDir, 'onecli-ca.pem');
  writePrivateFile(caPath, config.caCertificate);
  mounts.push({ hostPath: caPath, containerPath: config.caCertificateContainerPath, readonly: true });

  const systemBundle = '/etc/ssl/certs/ca-certificates.crt';
  const combinedPath = path.join(rootDir, 'combined-ca.pem');
  const systemCa = fs.existsSync(systemBundle) ? fs.readFileSync(systemBundle, 'utf8') : '';
  writePrivateFile(combinedPath, `${systemCa.trimEnd()}\n${config.caCertificate.trim()}\n`);
  mounts.push({ hostPath: combinedPath, containerPath: '/tmp/onecli-combined-ca.pem', readonly: true });
  env.SSL_CERT_FILE = '/tmp/onecli-combined-ca.pem';
  env.NODE_EXTRA_CA_CERTS = '/tmp/onecli-combined-ca.pem';
  env.DENO_CERT = '/tmp/onecli-combined-ca.pem';

  for (const [index, stub] of (config.credentialStubs ?? []).entries()) {
    assertSafeGuestPath(stub.containerPath);
    const stubPath = path.join(rootDir, `credential-stub-${index}`);
    writePrivateFile(stubPath, stub.content);
    mounts.push({ hostPath: stubPath, containerPath: stub.containerPath, readonly: true });
  }
  return { env, mounts };
}

function rewriteProxyUrl(key: string, value: string, host: string, port: number): string {
  if (!/(^|_)https?_proxy$/i.test(key)) return value;
  const url = new URL(value);
  url.hostname = host;
  url.port = String(port);
  return url.toString();
}

function assertSafeGuestPath(value: string): void {
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  const originalParts = value.replace(/\\/g, '/').split('/');
  if (!normalized.startsWith('/') || normalized === '/' || originalParts.includes('..')) {
    throw new Error(`Unsafe OneCLI credential stub path: ${value}`);
  }
}

function writePrivateFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}
