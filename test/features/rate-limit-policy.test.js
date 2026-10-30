import { describe, it, expect } from 'bun:test';
import { RateLimitPolicyFeature } from '../../features/agentic/rate-limit-policy/index.js';

describe('rate-limit-policy', () => {
  const f = new RateLimitPolicyFeature('rate-limit-policy', {
    policyName: 'bid-spam-protection',
    rateLimitConfigName: 'bid-spam-limits',
    namespace: 'agentgateway-proxy',
    targetHttpRoute: 'bids-mcp',
    limits: [
      { name: 'per-buyer-bid-rate', subject: { buyerId: 'buyer-1' }, requestsPerUnit: 10, unit: 'Minute' },
    ],
  });

  it('builds a RateLimitConfig with the configured limits', () => {
    const rlc = f.buildRateLimitConfig();
    expect(rlc.kind).toBe('RateLimitConfig');
    expect(rlc.apiVersion).toBe('enterpriseagentgateway.solo.io/v1alpha1');
    expect(rlc.metadata.name).toBe('bid-spam-limits');
    expect(rlc.metadata.namespace).toBe('agentgateway-proxy');
    expect(rlc.spec.limits).toEqual([
      { name: 'per-buyer-bid-rate', subject: { buyerId: 'buyer-1' }, requestsPerUnit: 10, unit: 'Minute' },
    ]);
  });

  it('builds a traffic policy targeting the configured HTTPRoute with entRateLimit discovery', () => {
    const p = f.buildTrafficPolicy();
    expect(p.kind).toBe('EnterpriseAgentgatewayPolicy');
    expect(p.apiVersion).toBe('enterpriseagentgateway.solo.io/v1alpha1');
    expect(p.metadata.name).toBe('bid-spam-protection');
    expect(p.spec.targetRefs).toEqual([
      { group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: 'bids-mcp' },
    ]);
    expect(p.spec.traffic.entRateLimit.discovery.namespaces.from).toBe('Same');
  });

  it('defaults discoveryFrom to Same', () => {
    expect(f.discoveryFrom).toBe('Same');
  });

  it('honors an explicit discoveryFrom override', () => {
    const custom = new RateLimitPolicyFeature('rate-limit-policy', {
      policyName: 'p', rateLimitConfigName: 'c', targetHttpRoute: 'r',
      limits: [{ name: 'x', subject: {}, requestsPerUnit: 1, unit: 'Second' }],
      discoveryFrom: 'All',
    });
    expect(custom.buildTrafficPolicy().spec.traffic.entRateLimit.discovery.namespaces.from).toBe('All');
  });

  it('validate throws when limits is empty', () => {
    const bad = new RateLimitPolicyFeature('rate-limit-policy', {
      policyName: 'p', rateLimitConfigName: 'c', targetHttpRoute: 'r', limits: [],
    });
    expect(() => bad.validate()).toThrow('limits');
  });

  it('validate throws when policyName is missing', () => {
    const bad = new RateLimitPolicyFeature('rate-limit-policy', {
      rateLimitConfigName: 'c', targetHttpRoute: 'r',
      limits: [{ name: 'x', subject: {}, requestsPerUnit: 1, unit: 'Second' }],
    });
    expect(() => bad.validate()).toThrow('policyName');
  });
});
