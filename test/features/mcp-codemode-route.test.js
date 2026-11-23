import { describe, it, expect } from 'bun:test';
import { McpCodemodeRouteFeature } from '../../features/agentic/mcp-codemode-route/index.js';

const BASE_CONFIG = {
  serverName: 'order-db',
  namespace: 'retail-returns',
  gatewayName: 'agentgateway',
  gatewayNamespace: 'agentgateway-proxy',
  mcpServiceHost: 'order-db-mcp.retail-returns.svc.cluster.local',
};

describe('mcp-codemode-route tool policy', () => {
  it('restricts the codemode Backend to tools/list only, by methodName', () => {
    const f = new McpCodemodeRouteFeature('mcp-codemode-route', BASE_CONFIG);
    const toolPolicy = f.buildToolPolicyFeature();
    expect(toolPolicy.staticBackendName).toBe('order-db-codemode');
    expect(toolPolicy.namespace).toBe('retail-returns');
    expect(toolPolicy.mode).toBe('authorization');
    expect(toolPolicy.action).toBe('Require');
    expect(toolPolicy.matchExpressions).toEqual(["mcp.methodName == 'tools/list'"]);
  });
});
