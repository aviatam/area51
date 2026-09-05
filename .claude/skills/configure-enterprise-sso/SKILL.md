---
name: configure-enterprise-sso
description: Configure Microsoft Entra ID or Okta SSO for Area51 registry sign-in through WorkOS AuthKit. Use when an organization wants enterprise identity, Azure AD, Entra ID, Okta, OIDC, or SAML login for Area51.
---

# Configure Enterprise SSO

Configure Microsoft Entra ID or Okta as the identity provider behind the
WorkOS AuthKit device flow that Area51 already uses for registry sign-in.

This workflow configures an external WorkOS organization and identity-provider
tenant. It does not add a second authentication implementation to Area51. The
Area51 client requests a WorkOS device authorization, receives the browser
verification URL, and exchanges the resulting WorkOS access token with the
configured Area51 registry broker.

Microsoft Teams is a separate integration. Use `/add-teams` when the goal is to
add a Teams messaging channel; use this skill when the goal is enterprise SSO
for Area51 registry access.

## Access boundary

Before making changes, use `AskUserQuestion` to confirm all three choices:

1. Identity provider: Microsoft Entra ID or Okta.
2. Protocol: OIDC (recommended) or SAML.
3. Registry ownership: the user administers both the Area51 registry broker's
   WorkOS environment and the matching WorkOS organization.

Stop if the user does not administer the broker and WorkOS environment. A user
of somebody else's hosted registry cannot enable tenant-wide SSO from an
Area51 checkout. Give that registry's operator the selected provider, protocol,
tenant domain, and the WorkOS organization to connect. Do not request or accept
client secrets in chat.

Also confirm that an administrator for the selected identity provider is
available. For Entra ID, they need permission to create or configure app and
enterprise-app registrations and assign users or groups. For Okta, they need
permission to create an app integration and assign users or groups.

## Record the current state

From the Area51 checkout, run:

```bash
pnpm exec tsx setup/index.ts --step registry
```

Record the broker URL, current signed-in identity, and image source. Do not
print or inspect files under `~/.config/area51`; they contain the account token.

Resolve the broker URL from `AREA51_REGISTRY_API` in the process environment or
`.env`. If it is absent, use `https://registry.area51.dev`. Probe only the
public authentication-discovery route:

```bash
curl -fsS "${AREA51_REGISTRY_API:-https://registry.area51.dev}/v1/auth-config"
```

A compatible broker returns JSON containing `device_flow_available`. When SSO
is enabled it also returns a WorkOS `client_id`; it may return custom
`device_authorization_endpoint` and `token_endpoint` values. A response without
`device_flow_available` is not a compatible Area51 registry broker.

## Configure the WorkOS application

In the WorkOS environment used by the registry broker:

1. Confirm AuthKit is configured for the application.
2. Enable CLI Auth for the application. Area51 uses the OAuth 2.0 Device
   Authorization Flow and the application's public client ID; it does not use a
   WorkOS API key or client secret on user machines.
3. In WorkOS, open or create the organization that represents the enterprise
   tenant.
4. Under that organization, create one Single Sign-On connection using the
   provider and protocol selected above.
5. Verify the enterprise email domain in WorkOS and configure its domain policy
   to require the SSO connection. Also require SSO in the organization policy
   for guest members whose email addresses are outside that verified domain.

Use the matching official WorkOS procedure and take redirect, ACS, or entity
values from the connection page instead of typing them from memory:

- Entra ID OIDC: https://workos.com/docs/integrations/entra-id-oidc
- Entra ID SAML: https://workos.com/docs/integrations/entra-id-saml
- Okta OIDC: https://workos.com/docs/integrations/okta-oidc
- Okta SAML: https://workos.com/docs/integrations/okta-saml
- WorkOS organization policies: https://workos.com/docs/authkit/organization-policies

Prefer OIDC for a new connection unless the organization's identity policy
requires SAML. Keep PKCE enabled for OIDC.

### Microsoft Entra ID

For OIDC, register a web application using the WorkOS redirect URI. Copy its
application client ID, a newly created client secret, and its OpenID Connect
metadata document URL into the WorkOS connection. Add the `email`,
`family_name`, and `given_name` ID-token claims. Assign only the intended users
or groups to the enterprise application.

For SAML, create a non-gallery enterprise application. Put the WorkOS IdP URI
in Entra's Identifier field and the WorkOS ACS URL in its Reply URL field.
Configure the email, given-name, name, and surname claim mappings documented by
WorkOS, assign the intended users or groups, and give WorkOS the App Federation
Metadata URL.

### Okta

For OIDC, create an OIDC Web Application using the WorkOS redirect URI. Limit
assignments to the intended groups. Copy the client ID, client secret, and the
tenant's OpenID configuration discovery endpoint into WorkOS. Require PKCE.

For SAML, create a SAML 2.0 integration. Put the WorkOS ACS URL in Okta's
Single Sign-On URL and the WorkOS SP Entity ID in its Audience URI. Assign only
the intended users or groups and give WorkOS the IdP metadata URL.

## Publish broker discovery

Configure the registry broker deployment to publish the WorkOS application's
public client ID from `GET /v1/auth-config`. Preserve the endpoint contract the
Area51 client validates:

- configured: a JSON response with `device_flow_available: true` and a nonempty
  `client_id`;
- deliberately disabled: a JSON response with
  `device_flow_available: false`;
- optional endpoint overrides: valid `device_authorization_endpoint` and
  `token_endpoint` URLs.

How the client ID reaches the broker is deployment-specific and lives outside
this repository. Use the broker deployment's existing secret/configuration
mechanism. Although the client ID is public, do not place the WorkOS API key,
an Entra client secret, or an Okta client secret in Area51's `.env` or source
tree.

For a one-machine diagnostic only, `AREA51_WORKOS_CLIENT_ID` can override the
broker-discovered client ID. Do not use that override as the production rollout
because it bypasses central discovery and must be repeated on every machine.

## Verify end to end

First verify discovery without exposing credentials:

```bash
curl -fsS "${AREA51_REGISTRY_API:-https://registry.area51.dev}/v1/auth-config"
```

Confirm that `device_flow_available` is true and `client_id` is nonempty. Then
force a fresh Area51 sign-in:

```bash
bash setup/registry-login.sh --force
```

Complete the browser flow with a user assigned to the Entra or Okta
application. Confirm that the terminal reports success, then run:

```bash
pnpm exec tsx setup/index.ts --step registry
```

Verify that it reports the expected signed-in email, a configured Docker
credential helper, and the intended hardened image source. If the registry
uses a non-default broker, set `AREA51_REGISTRY_API` in `.env` before both
commands.

Repeat the forced sign-in with an unassigned test user and confirm the identity
provider denies access. Use a test account; do not remove the current
operator's access while validating the rollout.

## Rollback

Before deleting the SSO connection, preserve an enrollment-code or other
documented break-glass path to the registry. Then:

1. Disable or delete the SSO connection in WorkOS.
2. Disable the corresponding Entra enterprise application or Okta app
   integration.
3. Configure the broker's `/v1/auth-config` response with
   `device_flow_available: false`, or restore the previous known-good WorkOS
   client ID.
4. Revoke this machine's registry account and remove its local credential
   helper:

```bash
pnpm exec tsx setup/index.ts --step registry -- --logout
```

5. Verify that registry status reports `not signed in`, then test the
   break-glass enrollment path on a separate test machine before closing the
   change.

## Troubleshooting

### Broker reports no identity provider

If `/v1/auth-config` returns `device_flow_available: false`, publish the public
WorkOS application client ID from the broker deployment and probe again. Do not
put an identity-provider client secret on the Area51 host.

### Broker response is rejected

A 404, HTML response, or JSON without `device_flow_available` points at the
wrong service or an incompatible broker. Correct `AREA51_REGISTRY_API`; do not
override the WorkOS endpoints to work around a wrong broker URL.

### WorkOS rejects the client ID

Confirm the client ID belongs to the same WorkOS environment as the configured
organization and has CLI Auth enabled. Test and production WorkOS environments
have different IDs and connections.

### Browser shows the wrong login method

Confirm the user's verified email domain and organization membership in WorkOS,
that the SSO connection is active, and that the user or group is assigned in
Entra or Okta. Re-run `bash setup/registry-login.sh --force` after correcting
the assignment.

### Sign-in succeeds but registry enrollment fails

The browser-side SSO connection is working. Check the broker logs for the
`method: idp`, `provider: workos` enrollment exchange and confirm the broker is
configured for the same WorkOS environment. Never paste the returned access
token into logs or chat.
