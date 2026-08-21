import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { prepareIncusOneCliConfig } from './incus-onecli.js';

describe('Incus OneCLI configuration', () => {
  it('rewrites Docker-only proxy DNS and materializes read-only credential files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-onecli-'));
    try {
      const result = prepareIncusOneCliConfig(
        {
          env: { HTTPS_PROXY: 'http://agent:secret@host.docker.internal:10255', SAFE: 'unchanged' },
          caCertificate: 'TEST-CA',
          caCertificateContainerPath: '/etc/onecli/ca.pem',
          credentialStubs: [{ containerPath: '/home/node/.config/tool/auth.json', content: 'onecli-managed' }],
        },
        root,
      );

      expect(result.env.HTTPS_PROXY).toBe('http://agent:secret@127.0.0.1:10255/');
      expect(result.env.SAFE).toBe('unchanged');
      expect(result.env.SSL_CERT_FILE).toBe('/tmp/onecli-combined-ca.pem');
      expect(result.mounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ containerPath: '/etc/onecli/ca.pem', readonly: true }),
          expect.objectContaining({ containerPath: '/home/node/.config/tool/auth.json', readonly: true }),
        ]),
      );
      if (process.platform !== 'win32') {
        for (const mount of result.mounts) expect(fs.statSync(mount.hostPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a credential stub outside an absolute guest path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'area51-onecli-'));
    try {
      expect(() =>
        prepareIncusOneCliConfig(
          {
            env: {},
            caCertificate: 'TEST-CA',
            caCertificateContainerPath: '/ca.pem',
            credentialStubs: [{ containerPath: '../../host', content: 'bad' }],
          },
          root,
        ),
      ).toThrow('Unsafe OneCLI credential stub path');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
