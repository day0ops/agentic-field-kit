import { test, expect, beforeEach, afterEach } from 'bun:test';
import { KeycloakFeature } from '../../addons/keycloak/index.js';

const ENV_KEYS = [
  'KEYCLOAK_ADMIN_USERNAME',
  'KEYCLOAK_ADMIN_PASSWORD',
  'KEYCLOAK_POSTGRES_USER',
  'KEYCLOAK_POSTGRES_PASSWORD',
  'GRAFANA_REALM_ADMIN_PASSWORD',
  'KAGENT_REALM_DEFAULT_PASSWORD',
  'AGENTREGISTRY_REALM_DEFAULT_PASSWORD',
];
let savedEnv;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // Baseline required vars so validate() only fails on what a given test is exercising.
  process.env.KEYCLOAK_ADMIN_USERNAME = 'admin';
  process.env.KEYCLOAK_ADMIN_PASSWORD = 'admin-pw';
  process.env.KEYCLOAK_POSTGRES_USER = 'postgres';
  process.env.KEYCLOAK_POSTGRES_PASSWORD = 'postgres-pw';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const realmConfig = realm => ({ realms: [{ realm, users: [] }] });

test('validate() does not require realm password env vars when no matching realm is configured', () => {
  const f = new KeycloakFeature('keycloak', realmConfig('something-else'));
  expect(f.validate()).toBe(true);
});

test("validate() does not require an env var for a 'finflow' realm (uses a fixed profile password)", () => {
  const f = new KeycloakFeature('keycloak', realmConfig('finflow'));
  expect(f.validate()).toBe(true);
});

for (const [realm, envVar] of [
  ['kagent', 'KAGENT_REALM_DEFAULT_PASSWORD'],
  ['agentregistry', 'AGENTREGISTRY_REALM_DEFAULT_PASSWORD'],
]) {
  test(`validate() throws when a '${realm}' realm is configured but ${envVar} is unset`, () => {
    const f = new KeycloakFeature('keycloak', realmConfig(realm));
    expect(() => f.validate()).toThrow(new RegExp(envVar));
  });

  test(`validate() passes when a '${realm}' realm is configured and ${envVar} is set`, () => {
    process.env[envVar] = 'a-secret-password';
    const f = new KeycloakFeature('keycloak', realmConfig(realm));
    expect(f.validate()).toBe(true);
  });
}

import {
  cleanup as keycloakRunbookCleanup,
  generate as keycloakRunbookGenerate,
} from '../../addons/keycloak/runbook.js';

function profileWith(eastAddonNames) {
  return {
    spec: {
      addons: { clusters: [{ name: 'east', addons: eastAddonNames.map(name => ({ name })) }] },
    },
  };
}

test('keycloak runbook generate annotates the Service for external-dns when external-dns is on the same cluster', async () => {
  const addonCfg = { namespace: 'keycloak', config: {} };
  const profile = profileWith(['keycloak', 'external-dns']);
  const md = await keycloakRunbookGenerate(1, addonCfg, 'east', profile, { spec: {} });
  expect(md).toContain(
    'kubectl annotate service keycloak -n keycloak "external-dns.alpha.kubernetes.io/hostname=$KEYCLOAK_HOSTNAME" --overwrite'
  );
});

test('keycloak runbook generate omits the external-dns annotation step when external-dns is not on the same cluster', async () => {
  const addonCfg = { namespace: 'keycloak', config: {} };
  const profile = profileWith(['keycloak']);
  const md = await keycloakRunbookGenerate(1, addonCfg, 'east', profile, { spec: {} });
  expect(md).not.toContain('external-dns.alpha.kubernetes.io/hostname');
});

test('keycloak runbook cleanup deletes the namespace only, not the full manifests', async () => {
  const md = await keycloakRunbookCleanup({ namespace: 'keycloak' }, 'east');
  expect(md).toContain(
    'kubectl --context $EAST_CONTEXT delete namespace keycloak --ignore-not-found=true'
  );
  expect(md).not.toContain('apiVersion:');
  expect(md).not.toContain('<<EOF');
});
