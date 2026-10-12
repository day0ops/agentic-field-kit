import { Feature } from '../../../src/lib/feature.js';

/**
 * KagentMcpServerFeature
 *
 * Applies a native kagent `MCPServer` CR (kagent.dev/v1alpha1) -- kagent
 * deploys and owns the pod itself from spec.deployment.image, unlike this
 * repo's own `mcp-server` feature (a plain Kubernetes Deployment) and unlike
 * AgentRegistry-catalogued servers (agentregistry-catalog). Required because
 * kagent's AccessPolicy (Stage 11) only resolves a `targetRef.kind: MCPServer`
 * against a real MCPServer.kagent.dev object -- not a plain Deployment, and
 * not a RemoteMCPServer (confirmed live: AccessPolicy's target lookup only
 * queries kmcp's MCPServerList, matching kagent-enterprise's own controller
 * source).
 *
 * The `kagent.solo.io/waypoint: "true"` label is required for kagent to
 * provision the Istio ambient waypoint (mcpserver-<name>-waypoint) that
 * AccessPolicy enforcement attaches to -- without it the server deploys fine
 * but no AccessPolicy targeting it can ever attach.
 *
 * Also applies a same-named `RemoteMCPServer` (kagent.dev/v1alpha3) pointing at
 * the MCPServer's own generated Service -- confirmed live that
 * AgentTemplate.spec.tools[].mcp.server is CEL-validated to require
 * `kind: RemoteMCPServer` with `apiGroup` entirely absent; binding an
 * AgentTemplate directly to a `kind: MCPServer` object is rejected at
 * admission. This is the only way an AgentTemplate (e.g. via substrate-agent's
 * `tools: [{ mcp: serverName }]`) can consume this server's tools.
 *
 * Configuration:
 * {
 *   serverName: string,      // Required -- MCPServer CR name
 *   namespace: string,       // Default: 'kagent-system'
 *   image: string,           // Required -- container image
 *   port: number,            // Default: 8080 -- container + MCP path port
 *   path: string,            // Default: '/mcp' -- HTTP transport mount path
 *   description: string,     // Default: `MCP server '<serverName>'` -- RemoteMCPServer.spec.description (required by its CRD)
 * }
 */
export class KagentMcpServerFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.serverName = config.serverName;
    this.namespace = config.namespace || 'kagent-system';
    this.image = config.image;
    this.port = config.port || 8080;
    this.path = config.path || '/mcp';
    this.description = config.description || `MCP server '${this.serverName}'`;
  }

  validate() {
    if (!this.serverName) throw new Error('kagent-mcp-server: serverName is required');
    if (!this.image) throw new Error('kagent-mcp-server: image is required');
    return true;
  }

  buildMcpServer() {
    return {
      apiVersion: 'kagent.dev/v1alpha1',
      kind: 'MCPServer',
      metadata: {
        name: this.serverName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentic-demo',
          'kagent.solo.io/waypoint': 'true',
        },
      },
      spec: {
        transportType: 'http',
        deployment: {
          image: this.image,
          port: this.port,
        },
        httpTransport: {
          path: this.path,
          targetPort: this.port,
        },
      },
    };
  }

  buildRemoteMcpServer() {
    return {
      apiVersion: 'kagent.dev/v1alpha3',
      kind: 'RemoteMCPServer',
      metadata: {
        name: this.serverName,
        namespace: this.namespace,
        labels: { 'app.kubernetes.io/managed-by': 'agentic-demo' },
      },
      spec: {
        description: this.description,
        url: `http://${this.serverName}.${this.namespace}.svc.cluster.local:${this.port}${this.path}`,
        protocol: 'STREAMABLE_HTTP',
      },
    };
  }

  async deploy() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.applyResource(this.buildMcpServer(), context);
      await this.applyResource(this.buildRemoteMcpServer(), context);
      this.log(
        `MCPServer '${this.serverName}' + RemoteMCPServer applied in namespace '${this.namespace}'`,
        'success'
      );
    }
  }

  async cleanup() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.deleteResource('remotemcpserver', this.serverName, this.namespace, context);
      await this.deleteResource('mcpserver', this.serverName, this.namespace, context);
    }
    this.log(`kagent-mcp-server '${this.serverName}' cleaned up`, 'success');
  }
}

export function createKagentMcpServerFeature(config) {
  return new KagentMcpServerFeature('kagent-mcp-server', config);
}
