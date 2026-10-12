import { test, expect } from 'bun:test';
import { generate as agwRunbookGenerate } from '../../addons/agentgateway/runbook.js';

const profile = { spec: { mesh: {}, gatewayApiVersion: 'v1.5.0' } };

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

test('agentgateway runbook omits the Istio Telemetry cleanup on a mesh-less profile', async () => {
  const meshlessProfile = { spec: {} };
  const addonCfg = {
    namespace: 'agentgateway-system',
    config: {
      enterprise: true,
      ambientEnabled: true,
      gateway: { hostname: '{{env.domains.app.main}}' },
    },
  };
  const md = await agwRunbookGenerate(1, addonCfg, 'east', meshlessProfile, { spec: {} });
  expect(md).not.toContain('kind: Telemetry');
  expect(md).not.toContain('disable-mesh-tracing');
});

test('agentgateway runbook includes the Istio Telemetry cleanup when a mesh is installed', async () => {
  const addonCfg = {
    namespace: 'agentgateway-system',
    config: {
      enterprise: true,
      ambientEnabled: true,
      gateway: { hostname: '{{env.domains.app.main}}' },
    },
  };
  const md = await agwRunbookGenerate(1, addonCfg, 'east', profile, { spec: {} });
  expect(md).toContain('kind: Telemetry');
  expect(md).toContain('disable-mesh-tracing');
});
