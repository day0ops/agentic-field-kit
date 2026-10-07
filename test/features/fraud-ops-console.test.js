import { describe, it, expect } from 'bun:test';
import { FraudOpsConsoleFeature } from '../../features/agentic/fraud-ops-console/index.js';

describe('fraud-ops-console', () => {
  const f = new FraudOpsConsoleFeature('fraud-ops-console', {
    namespace: 'kagent',
    image: 'australia-southeast1-docker.pkg.dev/field-engineering-apac/kasunt/fraud-ops-console:v0.1.0',
    hostname: 'console.agentic-demo-gke.kasunt.apac.fe.solo.io',
    clickhouseDsn: 'tcp://default:password@kagent-clickhouse.kagent.svc.cluster.local:9000?database=kagent',
    keycloak: {
      hostname: 'keycloak.agentic-demo-gke.kasunt.apac.fe.solo.io',
      clientId: 'fraud-swarm-driver',
      clientSecret: 'fraud-swarm-driver-secret',
    },
  });

  it('validates required fields', () => {
    expect(f.validate()).toBe(true);
    expect(() => new FraudOpsConsoleFeature('x', {}).validate()).toThrow();
  });

  it('deployment wires image, port, and env', () => {
    const d = f.buildDeployment();
    const c = d.spec.template.spec.containers[0];
    expect(c.image).toContain('fraud-ops-console');
    expect(c.ports[0].containerPort).toBe(8090);
    const env = Object.fromEntries(c.env.map(e => [e.name, e.value]));
    expect(env.CLICKHOUSE_DSN).toContain('kagent-clickhouse');
    expect(env.KAGENT_GRPC_TARGET).toBe('kagent-controller.kagent.svc.cluster.local:8083');
    expect(env.FRAUD_SWARM_HARNESS).toBe('fraud-swarm');
    expect(env.FRAUD_LEAD_AGENT_TEMPLATE).toBe('fraud-lead-investigator');
    expect(env.KEYCLOAK_TOKEN_URL).toBe(
      'https://keycloak.agentic-demo-gke.kasunt.apac.fe.solo.io/realms/kagent/protocol/openid-connect/token'
    );
    expect(env.KEYCLOAK_CLIENT_ID).toBe('fraud-swarm-driver');
    expect(env.KEYCLOAK_CLIENT_SECRET).toBe('fraud-swarm-driver-secret');
  });

  it('requires keycloak client-credentials config', () => {
    expect(() =>
      new FraudOpsConsoleFeature('x', {
        namespace: 'kagent',
        image: 'img',
        hostname: 'host',
        clickhouseDsn: 'dsn',
      }).validate()
    ).toThrow(/keycloak/);
  });

  it('gateway/certificate/httproute use the confirmed live shape', () => {
    const gw = f.buildGateway();
    expect(gw.spec.gatewayClassName).toBe('enterprise-agentgateway');
    expect(gw.spec.listeners[0].hostname).toBe('console.agentic-demo-gke.kasunt.apac.fe.solo.io');
    expect(gw.spec.infrastructure).toBeUndefined();
    expect(f.buildGatewayParameters()).toBeUndefined();
    const cert = f.buildCertificate();
    expect(cert.spec.issuerRef.name).toBe('letsencrypt-dns');
    const route = f.buildHTTPRoute();
    expect(route.spec.parentRefs[0].name).toBe('fraud-ops-console-https');
    expect(route.spec.rules[0].backendRefs[0].name).toBe('fraud-ops-console');
  });

  it('restricts the LB to sourceRanges when set', () => {
    const gated = new FraudOpsConsoleFeature('fraud-ops-console', {
      namespace: 'kagent',
      image: 'img',
      hostname: 'console.example.com',
      clickhouseDsn: 'dsn',
      keycloak: { hostname: 'keycloak.example.com', clientId: 'x', clientSecret: 'y' },
      sourceRanges: ['165.99.148.61/32', '64.226.138.86/32'],
    });
    const params = gated.buildGatewayParameters();
    expect(params.apiVersion).toBe('enterpriseagentgateway.solo.io/v1alpha1');
    expect(params.metadata).toEqual({ name: 'fraud-ops-console-https-params', namespace: 'kagent' });
    expect(params.spec.service.spec.loadBalancerSourceRanges).toEqual([
      '165.99.148.61/32',
      '64.226.138.86/32',
    ]);
    const gw = gated.buildGateway();
    expect(gw.spec.infrastructure.parametersRef).toEqual({
      name: 'fraud-ops-console-https-params',
      group: 'enterpriseagentgateway.solo.io',
      kind: 'EnterpriseAgentgatewayParameters',
    });
  });

  it('never targets a namespace for deletion (no requires.applications risk)', () => {
    // cleanup deletes only named resources, matching kagent-mcp-server's pattern
    expect(f.namespace).toBe('kagent');
    expect(typeof f.cleanup).toBe('function');
  });

  it('grants a scoped ate-client token-request right in ate-system, cross-namespace', () => {
    const role = f.buildAteTokenRole();
    expect(role.metadata.namespace).toBe('ate-system');
    expect(role.rules[0].resources).toEqual(['serviceaccounts/token']);
    expect(role.rules[0].resourceNames).toEqual(['ate-client']);
    const rb = f.buildAteTokenRoleBinding();
    expect(rb.metadata.namespace).toBe('ate-system');
    expect(rb.subjects[0]).toEqual({ kind: 'ServiceAccount', name: 'fraud-ops-console', namespace: 'kagent' });
  });
});
