import { describe, it, expect } from 'bun:test';
import { SubstrateA2ARouteFeature } from '../../features/agentic/substrate-a2a-route/index.js';

describe('substrate-a2a-route', () => {
  const f = new SubstrateA2ARouteFeature('substrate-a2a-route', {
    agentName: 'shopping-assistant',
    namespace: 'kagent-system',
    gatewayName: 'agora-console-https',
    gatewayNamespace: 'kagent-system',
  });

  it('builds a Backend pointing at kagent-controller, named after the controller not the agent', () => {
    const backend = f.buildBackend();
    expect(backend.apiVersion).toBe('enterpriseagentgateway.solo.io/v1alpha1');
    expect(backend.kind).toBe('EnterpriseAgentgatewayBackend');
    expect(backend.metadata.name).toBe('kagent-controller-a2a');
    expect(backend.metadata.namespace).toBe('kagent-system');
    expect(backend.spec.a2a).toEqual({
      host: 'kagent-controller.kagent-system.svc.cluster.local',
      port: 8083,
    });
  });

  it('builds a path-preserving HTTPRoute with no URLRewrite filter', () => {
    const route = f.buildHTTPRoute();
    expect(route.apiVersion).toBe('gateway.networking.k8s.io/v1');
    expect(route.kind).toBe('HTTPRoute');
    expect(route.metadata.name).toBe('shopping-assistant-a2a');
    expect(route.metadata.namespace).toBe('kagent-system');
    expect(route.spec.parentRefs).toEqual([
      { name: 'agora-console-https', namespace: 'kagent-system' },
    ]);
    const rule = route.spec.rules[0];
    expect(rule.matches).toEqual([
      { path: { type: 'PathPrefix', value: '/agents/kagent-system/shopping-assistant' } },
    ]);
    expect(rule.filters).toBeUndefined();
    expect(rule.backendRefs).toEqual([
      {
        group: 'enterpriseagentgateway.solo.io',
        kind: 'EnterpriseAgentgatewayBackend',
        name: 'kagent-controller-a2a',
      },
    ]);
  });

  it('two agents behind the same controller produce the same Backend but different HTTPRoutes', () => {
    const other = new SubstrateA2ARouteFeature('substrate-a2a-route', {
      agentName: 'listing-pricing-assistant',
      namespace: 'kagent-system',
      gatewayName: 'agora-console-https',
      gatewayNamespace: 'kagent-system',
    });
    expect(other.buildBackend()).toEqual(f.buildBackend());
    expect(other.buildHTTPRoute().metadata.name).toBe('listing-pricing-assistant-a2a');
    expect(other.buildHTTPRoute().spec.rules[0].matches[0].path.value).toBe(
      '/agents/kagent-system/listing-pricing-assistant'
    );
  });

  it('agentNamespace overrides the path namespace independently of where this feature applies its own resources', () => {
    const cross = new SubstrateA2ARouteFeature('substrate-a2a-route', {
      agentName: 'shopping-assistant',
      agentNamespace: 'other-ns',
      namespace: 'kagent-system',
      gatewayName: 'agora-console-https',
      gatewayNamespace: 'kagent-system',
    });
    expect(cross.buildHTTPRoute().spec.rules[0].matches[0].path.value).toBe(
      '/agents/other-ns/shopping-assistant'
    );
    expect(cross.buildHTTPRoute().metadata.namespace).toBe('kagent-system');
  });

  it('controllerServiceName/controllerNamespace/controllerPort override the Backend target', () => {
    const custom = new SubstrateA2ARouteFeature('substrate-a2a-route', {
      agentName: 'shopping-assistant',
      namespace: 'kagent-system',
      gatewayName: 'agora-console-https',
      gatewayNamespace: 'kagent-system',
      controllerServiceName: 'my-controller',
      controllerNamespace: 'other-system',
      controllerPort: 9999,
    });
    expect(custom.buildBackend().metadata.name).toBe('my-controller-a2a');
    expect(custom.buildBackend().spec.a2a).toEqual({
      host: 'my-controller.other-system.svc.cluster.local',
      port: 9999,
    });
  });

  it('omits spec.hostnames when hostname is not set', () => {
    expect(f.buildHTTPRoute().spec.hostnames).toBeUndefined();
  });

  it('sets spec.hostnames when hostname is configured, so it wins routing precedence over a catch-all route on the same Gateway', () => {
    const hosted = new SubstrateA2ARouteFeature('substrate-a2a-route', {
      agentName: 'shopping-assistant',
      namespace: 'kagent-system',
      gatewayName: 'agora-console-https',
      gatewayNamespace: 'kagent-system',
      hostname: 'agora.lab.day0ops.com',
    });
    expect(hosted.buildHTTPRoute().spec.hostnames).toEqual(['agora.lab.day0ops.com']);
  });

  it('validate requires agentName, namespace, gatewayName, gatewayNamespace', () => {
    expect(() =>
      new SubstrateA2ARouteFeature('substrate-a2a-route', {
        namespace: 'kagent-system',
        gatewayName: 'g',
        gatewayNamespace: 'kagent-system',
      }).validate()
    ).toThrow('agentName');
    expect(() =>
      new SubstrateA2ARouteFeature('substrate-a2a-route', {
        agentName: 'shopping-assistant',
        gatewayNamespace: 'kagent-system',
      }).validate()
    ).toThrow('gatewayName');
    expect(() =>
      new SubstrateA2ARouteFeature('substrate-a2a-route', {
        agentName: 'shopping-assistant',
        namespace: 'kagent-system',
        gatewayName: 'g',
      }).validate()
    ).toThrow('gatewayNamespace');
    expect(f.validate()).toBe(true);
  });
});
