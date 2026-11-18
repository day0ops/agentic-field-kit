import { describe, it, expect } from 'bun:test';
import { OpenapiMcpBackendFeature } from '../../features/agentic/openapi-mcp-backend/index.js';

const SCHEMA = 'openapi: 3.0.0\ninfo:\n  title: listings\n  version: "1"\npaths: {}\n';

describe('openapi-mcp-backend', () => {
  const f = new OpenapiMcpBackendFeature('openapi-mcp-backend', {
    backendName: 'listings-mcp',
    namespace: 'agentgateway-proxy',
    openapiSchema: SCHEMA,
    hostname: 'listings-mcp.internal.example.com',
    gatewayName: 'internal-mcp-gateway',
  });

  it('builds a ConfigMap holding the OpenAPI schema', () => {
    const cm = f.buildConfigMap();
    expect(cm.kind).toBe('ConfigMap');
    expect(cm.metadata.name).toBe('listings-mcp-openapi-schema');
    expect(cm.metadata.namespace).toBe('agentgateway-proxy');
    expect(cm.data['openapi.yaml']).toBe(SCHEMA);
  });

  it('builds an EnterpriseAgentgatewayBackend referencing the ConfigMap', () => {
    const b = f.buildBackend();
    expect(b.kind).toBe('EnterpriseAgentgatewayBackend');
    expect(b.apiVersion).toBe('enterpriseagentgateway.solo.io/v1alpha1');
    expect(b.metadata.name).toBe('listings-mcp');
    expect(b.spec.entMcp.openapi.configMapRef.name).toBe('listings-mcp-openapi-schema');
  });

  it('builds an HTTPRoute pointing at the backend', () => {
    const r = f.buildHTTPRoute();
    expect(r.kind).toBe('HTTPRoute');
    expect(r.spec.hostnames).toEqual(['listings-mcp.internal.example.com']);
    expect(r.spec.parentRefs[0].name).toBe('internal-mcp-gateway');
    expect(r.spec.rules[0].backendRefs[0]).toEqual({
      group: 'enterpriseagentgateway.solo.io',
      kind: 'EnterpriseAgentgatewayBackend',
      name: 'listings-mcp',
    });
  });

  it('builds a RemoteMCPServer pointing at the HTTPRoute hostname, defaulting name/namespace to backendName/namespace', () => {
    const r = f.buildRemoteMcpServer();
    expect(r.kind).toBe('RemoteMCPServer');
    expect(r.apiVersion).toBe('api.kagent.dev/v1alpha3');
    expect(r.metadata.name).toBe('listings-mcp');
    expect(r.metadata.namespace).toBe('agentgateway-proxy');
    expect(r.spec.url).toBe('https://listings-mcp.internal.example.com/mcp');
    expect(r.spec.protocol).toBe('STREAMABLE_HTTP');
  });

  it('validate throws when openapiSchema is missing', () => {
    const bad = new OpenapiMcpBackendFeature('openapi-mcp-backend', {
      backendName: 'x',
      hostname: 'h',
      gatewayName: 'g',
    });
    expect(() => bad.validate()).toThrow('openapiSchema');
  });
});

describe('openapi-mcp-backend with remoteMcpServer overrides', () => {
  const f = new OpenapiMcpBackendFeature('openapi-mcp-backend', {
    backendName: 'listings-mcp',
    namespace: 'agentgateway-proxy',
    openapiSchema: SCHEMA,
    hostname: 'listings-mcp.internal.example.com',
    gatewayName: 'internal-mcp-gateway',
    remoteMcpServerName: 'listings',
    remoteMcpServerNamespace: 'kagent-system',
  });

  it('honors remoteMcpServerName/remoteMcpServerNamespace overrides', () => {
    const r = f.buildRemoteMcpServer();
    expect(r.metadata.name).toBe('listings');
    expect(r.metadata.namespace).toBe('kagent-system');
  });
});
