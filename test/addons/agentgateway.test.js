import { test, expect } from 'bun:test';
import { generate as agwRunbookGenerate } from '../../addons/agentgateway/runbook.js';
import { AgentgatewayFeature } from '../../addons/agentgateway/index.js';

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

test('agentgateway runbook applies OTel telemetry policies for ui.enabled profiles with no soloUiNamespace', async () => {
  const addonCfg = {
    namespace: 'agentgateway-system',
    config: {
      enterprise: true,
      ambientEnabled: true,
      telemetryGatewayName: 'agora-console-https',
      telemetryGatewayNamespace: 'kagent-system',
      tracesCollectorName: 'enterprise-agentgateway-ui-telemetry-collector',
      tracesCollectorNamespace: 'agentgateway-system',
      ui: {
        enabled: true,
        hostname: '{{env.domains.core.agentgatewayUi}}',
        oidc: { issuer: 'https://keycloak.example.com/realms/kagent' },
      },
    },
  };
  const md = await agwRunbookGenerate(1, addonCfg, 'east', profile, { spec: {} });
  expect(md).toContain('otel-tracing-policy');
  expect(md).toContain('otel-access-log-policy');
  expect(md).toContain('name: agora-console-https');
  expect(md).toContain('name: enterprise-agentgateway-ui-telemetry-collector');
});

test('agentgateway runbook omits OTel telemetry policies with no soloUiNamespace or ui.enabled', async () => {
  const addonCfg = {
    namespace: 'agentgateway-system',
    config: {
      enterprise: true,
      ambientEnabled: true,
      telemetryGatewayName: 'agora-console-https',
      telemetryGatewayNamespace: 'kagent-system',
      tracesCollectorName: 'enterprise-agentgateway-ui-telemetry-collector',
      tracesCollectorNamespace: 'agentgateway-system',
    },
  };
  const md = await agwRunbookGenerate(1, addonCfg, 'east', profile, { spec: {} });
  expect(md).not.toContain('otel-tracing-policy');
});

test('buildUiHelmArgs sets ui.features.costManagement=true when ui.costManagement is enabled', () => {
  const feature = new AgentgatewayFeature('agentgateway', {
    enterprise: true,
    ui: {
      enabled: true,
      hostname: 'agw-ui.example.com',
      oidc: { issuer: 'https://keycloak.example.com/realms/kagent', backendClientSecret: 'secret' },
      costManagement: true,
    },
  });
  const args = feature.buildUiHelmArgs();
  expect(args).toContain('ui.features.costManagement=true');
});

test('buildUiHelmArgs omits ui.costManagement when not configured', () => {
  const feature = new AgentgatewayFeature('agentgateway', {
    enterprise: true,
    ui: {
      enabled: true,
      hostname: 'agw-ui.example.com',
      oidc: { issuer: 'https://keycloak.example.com/realms/kagent', backendClientSecret: 'secret' },
    },
  });
  const args = feature.buildUiHelmArgs();
  expect(args).not.toContain('ui.features.costManagement=true');
});

test('agentgateway runbook includes --set ui.features.costManagement=true when ui.costManagement is enabled', async () => {
  const addonCfg = {
    namespace: 'agentgateway-system',
    config: {
      enterprise: true,
      ambientEnabled: true,
      ui: {
        enabled: true,
        hostname: '{{env.domains.core.agentgatewayUi}}',
        oidc: { issuer: 'https://keycloak.example.com/realms/kagent' },
        costManagement: true,
      },
    },
  };
  const md = await agwRunbookGenerate(1, addonCfg, 'east', profile, { spec: {} });
  expect(md).toContain('--set ui.features.costManagement=true');
});
