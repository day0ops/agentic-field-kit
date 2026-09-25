import { test, expect } from 'bun:test';
import {
  generate as soloUiRunbookGenerate,
  cleanup as soloUiRunbookCleanup,
} from '../../addons/solo-ui/runbook.js';

test('solo-ui runbook documents the Keycloak CA-trust patch when OIDC is enabled', async () => {
  const addonCfg = {
    namespace: 'solo-enterprise',
    config: {
      mode: 'management',
      oidc: { enabled: true, issuerUrl: 'https://{{env.domains.core.keycloak}}/realms/solo-ui' },
    },
  };
  const md = await soloUiRunbookGenerate(1, addonCfg, 'east', {}, { spec: {} });
  expect(md).toContain('ui-backend` crash-loops with `tls: failed to verify certificate');
  expect(md).toContain('kubectl create configmap keycloak-ca -n solo-enterprise');
  expect(md).toContain('kubectl patch deployment solo-enterprise-ui -n solo-enterprise');
  expect(md).toContain('SSL_CERT_FILE');
});

test('solo-ui runbook omits the Keycloak CA-trust note when OIDC is disabled', async () => {
  const addonCfg = { namespace: 'solo-enterprise', config: { mode: 'management' } };
  const md = await soloUiRunbookGenerate(1, addonCfg, 'east', {}, { spec: {} });
  expect(md).not.toContain('keycloak-ca');
});

test('solo-ui runbook cleanup targets the cluster it was installed on (multi-cluster: management on east, relay on west)', () => {
  const managementMd = soloUiRunbookCleanup(
    { namespace: 'solo-enterprise', mode: 'management' },
    'east'
  );
  expect(managementMd).toContain(
    'helm uninstall solo-ui solo-ui-crds -n solo-enterprise --kube-context $EAST_CONTEXT'
  );

  const relayMd = soloUiRunbookCleanup({ namespace: 'solo-enterprise', mode: 'relay' }, 'west');
  expect(relayMd).toContain(
    'helm uninstall solo-relay -n solo-enterprise --kube-context $WEST_CONTEXT'
  );
});
