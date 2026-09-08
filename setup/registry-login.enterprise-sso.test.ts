import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  enroll,
  pollForIdpToken,
  probeBroker,
  requestDeviceAuthorization,
  type ClientRecord,
  type IdpConfig,
} from './registry-login.js';

type Provider = 'entra' | 'okta';
type Outcome = 'allowed' | 'idp-denied' | 'broker-denied';

const originalClientId = process.env.AREA51_WORKOS_CLIENT_ID;
const originalDeviceEndpoint = process.env.AREA51_WORKOS_DEVICE_ENDPOINT;
const originalTokenEndpoint = process.env.AREA51_WORKOS_TOKEN_ENDPOINT;

let server: http.Server | undefined;

beforeEach(() => {
  delete process.env.AREA51_WORKOS_CLIENT_ID;
  delete process.env.AREA51_WORKOS_DEVICE_ENDPOINT;
  delete process.env.AREA51_WORKOS_TOKEN_ENDPOINT;
});

afterEach(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
  server = undefined;
  restoreEnv('AREA51_WORKOS_CLIENT_ID', originalClientId);
  restoreEnv('AREA51_WORKOS_DEVICE_ENDPOINT', originalDeviceEndpoint);
  restoreEnv('AREA51_WORKOS_TOKEN_ENDPOINT', originalTokenEndpoint);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

async function mockEnterpriseSso(
  provider: Provider,
  outcome: Outcome,
): Promise<{
  api: string;
  enrollRequests: Array<Record<string, unknown>>;
}> {
  const enrollRequests: Array<Record<string, unknown>> = [];
  server = http.createServer(async (req, res) => {
    const api = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    res.setHeader('content-type', 'application/json');

    if (req.method === 'GET' && req.url === '/v1/auth-config') {
      res.end(
        JSON.stringify({
          device_flow_available: true,
          client_id: `client-${provider}`,
          device_authorization_endpoint: `${api}/workos/device`,
          token_endpoint: `${api}/workos/token`,
        }),
      );
      return;
    }
    if (req.method === 'POST' && req.url === '/workos/device') {
      res.end(
        JSON.stringify({
          device_code: `device-${provider}`,
          user_code: 'AREA-5151',
          verification_uri: `${api}/verify`,
          expires_in: 30,
          interval: 1,
        }),
      );
      return;
    }
    if (req.method === 'POST' && req.url === '/workos/token') {
      if (outcome === 'idp-denied') {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'access_denied', error_description: 'User is not assigned' }));
      } else {
        res.end(JSON.stringify({ access_token: `idp-token-${provider}` }));
      }
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/enroll') {
      const request = await body(req);
      enrollRequests.push(request);
      if (outcome === 'broker-denied') {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: 'unknown_user' }));
      } else {
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            account_id: `account-${provider}`,
            email: `assigned@${provider}.example`,
            token: `registry-token-${provider}`,
            registry: 'registry.area51.dev',
          }),
        );
      }
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise<void>((resolve, reject) => server!.listen(0, '127.0.0.1', resolve).once('error', reject));
  return { api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, enrollRequests };
}

async function discoveredConfig(api: string): Promise<IdpConfig> {
  const probe = await probeBroker(api);
  expect(probe.kind).toBe('idp');
  if (probe.kind !== 'idp') throw new Error('expected IdP discovery');
  return probe.config;
}

async function idpToken(api: string): Promise<string> {
  const config = await discoveredConfig(api);
  const device = await requestDeviceAuthorization(config);
  return pollForIdpToken(config, device);
}

const client: ClientRecord = {
  os: 'linux',
  arch: 'x64',
  area51_version: 'test',
  host_id: 'acceptance-host',
};

describe.each<Provider>(['entra', 'okta'])('%s enterprise SSO contract', (provider) => {
  it('enrolls an assigned user and sends the IdP bearer only in the documented field', async () => {
    const mock = await mockEnterpriseSso(provider, 'allowed');
    const token = await idpToken(mock.api);
    const result = await enroll(mock.api, { method: 'idp', provider: 'workos', access_token: token, client });

    expect(result.credential).toMatchObject({
      account_id: `account-${provider}`,
      email: `assigned@${provider}.example`,
      token: `registry-token-${provider}`,
    });
    expect(mock.enrollRequests).toHaveLength(1);
    expect(mock.enrollRequests[0]).toMatchObject({
      method: 'idp',
      provider: 'workos',
      install_id: client.host_id,
      workos_token: `idp-token-${provider}`,
    });
    expect(mock.enrollRequests[0]).not.toHaveProperty('access_token');
  });

  it('stops an unassigned user at the identity provider without contacting enrollment', async () => {
    const mock = await mockEnterpriseSso(provider, 'idp-denied');

    await expect(idpToken(mock.api)).rejects.toThrow('sign-in was declined');
    expect(mock.enrollRequests).toHaveLength(0);
  });

  it('issues no credential when the broker rejects an identity-provider user', async () => {
    const mock = await mockEnterpriseSso(provider, 'broker-denied');
    const token = await idpToken(mock.api);

    await expect(enroll(mock.api, { method: 'idp', provider: 'workos', access_token: token, client })).rejects.toThrow(
      'account service rejected',
    );
    expect(mock.enrollRequests).toHaveLength(1);
  });
});
