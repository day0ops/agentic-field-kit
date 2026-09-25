// test/lib/arctl.test.js
import { test, expect } from 'bun:test';
import { isAuthError } from '../../src/lib/arctl.js';

test('recognizes a stale cached session whose OIDC issuer no longer resolves', () => {
  // Real message from arctl when a locally-cached session's OIDC issuer host
  // has stopped resolving (e.g. after an environment's domain changed) and the
  // fallback locally-decoded JWT is also expired.
  const message = [
    'Could not query registry (resolving registry token: failed to refresh token: ' +
      'failed to discover OIDC configuration: OpenID Provider Configuration Discovery has failed',
    'Get "https://keycloak.mesh.kasunt.apac.fe.solo.io/realms/agentregistry/.well-known/openid-configuration"' +
      ': dial tcp: lookup keycloak.mesh.kasunt.apac.fe.solo.io: no such host), showing local token info only',
    '',
    'Error: failed to parse JWT: "exp" not satisfied',
  ].join('\n');

  expect(isAuthError(message)).toBe(true);
});

test('still recognizes the previously-covered client auth phrasings', () => {
  expect(isAuthError('Error: unauthenticated')).toBe(true);
  expect(isAuthError('session expired, please log in again')).toBe(true);
  expect(isAuthError('token is invalid')).toBe(true);
});

test('does not misclassify unrelated failures as auth errors', () => {
  expect(isAuthError('arctl apply failed: manifest invalid: missing field "name"')).toBe(false);
  expect(isAuthError('authentication token expired during deployment; please retry')).toBe(false);
});
