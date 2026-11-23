import { test, expect } from 'bun:test';
import { AgentregistryFeature } from '../../addons/agentregistry/index.js';

function makeOtelGatewayFeature(extra = {}) {
  return new AgentregistryFeature('agentregistry', {
    enterprise: true,
    namespace: 'agentregistry-system',
    otelGateway: {
      enabled: true,
      hostname: 'agentregistry-telemetry.example.com',
      upstreamEndpoint: 'http://tempo.telemetry:4318',
    },
    ...extra,
  });
}

test('_deployOtelGateway leaves the Gateway open when no sourceRanges are configured', async () => {
  const feature = makeOtelGatewayFeature();
  const applied = [];
  feature.applyResource = async resource => applied.push(resource);

  await feature._deployOtelGateway();

  const params = applied.filter(r => r.kind === 'EnterpriseAgentgatewayParameters');
  expect(params.length).toBe(0);

  const gateway = applied.find(
    r => r.kind === 'Gateway' && r.metadata.name === 'agentregistry-telemetry-https'
  );
  expect(gateway.spec.infrastructure).toBeUndefined();
});

test('_deployOtelGateway restricts the public LB via EnterpriseAgentgatewayParameters when sourceRanges are configured', async () => {
  const feature = makeOtelGatewayFeature({ sourceRanges: ['10.0.0.0/8'] });
  const applied = [];
  feature.applyResource = async resource => applied.push(resource);

  await feature._deployOtelGateway();

  const params = applied.find(
    r =>
      r.kind === 'EnterpriseAgentgatewayParameters' &&
      r.metadata.name === 'agentregistry-telemetry-https-params'
  );
  expect(params).toBeDefined();
  expect(params.spec.service.spec.loadBalancerSourceRanges).toEqual(['10.0.0.0/8']);

  const gateway = applied.find(
    r => r.kind === 'Gateway' && r.metadata.name === 'agentregistry-telemetry-https'
  );
  expect(gateway.spec.infrastructure).toEqual({
    parametersRef: {
      name: 'agentregistry-telemetry-https-params',
      group: 'enterpriseagentgateway.solo.io',
      kind: 'EnterpriseAgentgatewayParameters',
    },
  });
});
