import { describe, it, expect } from 'bun:test';
import { KagentMcpServerFeature } from '../../features/agentic/kagent-mcp-server/index.js';

describe('kagent-mcp-server (default: Deployment + Service)', () => {
  const f = new KagentMcpServerFeature('kagent-mcp-server', {
    serverName: 'core-banking-mcp',
    namespace: 'kagent',
    image:
      'australia-southeast1-docker.pkg.dev/field-engineering-apac/kasunt/core-banking-mcp:v0.1.0',
    port: 9110,
  });

  it('builds a Deployment running the server image on the configured port', () => {
    const d = f.buildDeployment();
    expect(d.kind).toBe('Deployment');
    expect(d.metadata.name).toBe('core-banking-mcp');
    expect(d.metadata.namespace).toBe('kagent');
    expect(d.spec.template.spec.containers[0].image).toBe(
      'australia-southeast1-docker.pkg.dev/field-engineering-apac/kasunt/core-banking-mcp:v0.1.0'
    );
    expect(d.spec.template.spec.containers[0].ports[0].containerPort).toBe(9110);
    expect(d.spec.selector.matchLabels).toEqual({ app: 'core-banking-mcp' });
  });

  it('builds a Service exposing the same port with a matching selector', () => {
    const s = f.buildService();
    expect(s.kind).toBe('Service');
    expect(s.metadata.name).toBe('core-banking-mcp');
    expect(s.spec.selector).toEqual({ app: 'core-banking-mcp' });
    expect(s.spec.ports[0].port).toBe(9110);
    expect(s.spec.ports[0].targetPort).toBe(9110);
  });

  it('builds a same-named RemoteMCPServer at the api.kagent.dev group, pointing at the Service', () => {
    const r = f.buildRemoteMcpServer();
    expect(r.apiVersion).toBe('api.kagent.dev/v1alpha3');
    expect(r.kind).toBe('RemoteMCPServer');
    expect(r.metadata.name).toBe('core-banking-mcp');
    expect(r.spec.url).toBe('http://core-banking-mcp.kagent.svc.cluster.local:9110/mcp');
    expect(r.spec.protocol).toBe('STREAMABLE_HTTP');
    expect(r.spec.description).toBeTruthy();
  });

  it('includes env vars on the container when env is set', () => {
    const withEnv = new KagentMcpServerFeature('kagent-mcp-server', {
      serverName: 'bids-mcp',
      namespace: 'agora-demo',
      image: 'example.com/bids-mcp:v1',
      port: 9101,
      env: [
        { name: 'CATALOG_API_URL', value: 'http://catalog-api.agora-demo.svc.cluster.local:18080' },
      ],
    });
    const d = withEnv.buildDeployment();
    expect(d.spec.template.spec.containers[0].env).toEqual([
      { name: 'CATALOG_API_URL', value: 'http://catalog-api.agora-demo.svc.cluster.local:18080' },
    ]);
  });

  it('omits env entirely when not set, matching existing callers', () => {
    expect(f.buildDeployment().spec.template.spec.containers[0].env).toBeUndefined();
  });
});

describe('kagent-mcp-server (legacyNativeMcpServer: true)', () => {
  const f = new KagentMcpServerFeature('kagent-mcp-server', {
    serverName: 'returns-eligibility',
    namespace: 'kagent-system',
    image: 'example.com/returns-eligibility:v1',
    legacyNativeMcpServer: true,
  });

  it('builds a native MCPServer CR with the waypoint label', () => {
    const s = f.buildMcpServer();
    expect(s.apiVersion).toBe('kagent.dev/v1alpha1');
    expect(s.kind).toBe('MCPServer');
    expect(s.metadata.name).toBe('returns-eligibility');
    expect(s.metadata.labels['kagent.solo.io/waypoint']).toBe('true');
    expect(s.spec.deployment.image).toBe('example.com/returns-eligibility:v1');
  });

  it('builds a RemoteMCPServer at the legacy kagent.dev group', () => {
    const r = f.buildRemoteMcpServer();
    expect(r.apiVersion).toBe('kagent.dev/v1alpha3');
    expect(r.kind).toBe('RemoteMCPServer');
    expect(r.spec.url).toBe('http://returns-eligibility.kagent-system.svc.cluster.local:8080/mcp');
  });
});
