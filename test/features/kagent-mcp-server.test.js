import { describe, it, expect } from 'bun:test';
import { KagentMcpServerFeature } from '../../features/agentic/kagent-mcp-server/index.js';

describe('kagent-mcp-server', () => {
  const f = new KagentMcpServerFeature('kagent-mcp-server', {
    serverName: 'core-banking-mcp',
    namespace: 'kagent',
    image: 'australia-southeast1-docker.pkg.dev/field-engineering-apac/kasunt/core-banking-mcp:v0.1.0',
    port: 9110,
  });

  it('builds an MCPServer CR with the waypoint label', () => {
    const s = f.buildMcpServer();
    expect(s.kind).toBe('MCPServer');
    expect(s.metadata.name).toBe('core-banking-mcp');
    expect(s.metadata.labels['kagent.solo.io/waypoint']).toBe('true');
    expect(s.spec.deployment.port).toBe(9110);
  });

  it('builds a same-named RemoteMCPServer pointing at the MCPServer Service, no apiGroup', () => {
    const r = f.buildRemoteMcpServer();
    expect(r.kind).toBe('RemoteMCPServer');
    expect(r.metadata.name).toBe('core-banking-mcp');
    expect(r.spec.url).toBe('http://core-banking-mcp.kagent.svc.cluster.local:9110/mcp');
    expect(r.spec.protocol).toBe('STREAMABLE_HTTP');
    expect(r.spec.description).toBeTruthy();
    expect(r.spec.apiGroup).toBeUndefined();
  });
});
