import { test, expect } from 'bun:test';
import { generate as agwRunbookGenerate } from '../../addons/agentgateway/runbook.js';

const profile = { spec: { mesh: { gatewayApiVersion: 'v1.5.0' } } };

test('agentgateway runbook Gateway resource uses a listener hostname, not spec.addresses (rejected by the controller as AddressNotUsable)', async () => {
  const addonCfg = {
    namespace: 'agentgateway-system',
    config: {
      enterprise: true,
      ambientEnabled: true,
      gateway: { hostname: '{{env.domains.app.main}}' },
    },
  };
  const md = await agwRunbookGenerate(1, addonCfg, 'east', profile, { spec: {} });
  expect(md).toContain('hostname: $AGENTGATEWAY_HOSTNAME');
  expect(md).not.toContain('addresses:');
  expect(md).not.toContain('type: Hostname');
});

test('agentgateway runbook Gateway resource omits hostname for a spoke gateway', async () => {
  const addonCfg = {
    namespace: 'agentgateway-system',
    config: { enterprise: true, ambientEnabled: true, globalGateway: true },
  };
  const md = await agwRunbookGenerate(1, addonCfg, 'west', profile, { spec: {} });
  expect(md).not.toContain('hostname:');
  expect(md).not.toContain('addresses:');
});
