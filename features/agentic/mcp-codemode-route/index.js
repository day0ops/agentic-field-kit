import { Feature } from '../../../src/lib/feature.js';

/**
 * McpCodemodeRouteFeature
 *
 * Stage 4 of the guided tour (progressive disclosure): exposes an MCP server
 * a SECOND time, through a separate EnterpriseAgentgatewayBackend using
 * spec.entMcp (not spec.mcp) with codeMode enabled -- collapsing that
 * server's tool catalog into a single code-execution meta-tool instead of N
 * individually-described tool schemas. A distinct Backend+HTTPRoute, not a
 * patch on AgentRegistry's own dynamically-created Backend for this server:
 * entMcp is a different backend type from AgentRegistry's plain mcp (its own
 * spec.entMcp.targets, confirmed via kubectl explain), and AgentRegistry
 * reconciles its own Backend on its own schedule -- a live patch onto that
 * object risks being silently reverted. Same static-target shape AgentRegistry
 * itself uses (spec.mcp.targets[].static: {host, path, port, protocol}),
 * confirmed live against order-db's actual deployed Backend, just under
 * entMcp instead of mcp.
 *
 * Configuration:
 * {
 *   serverName: string,          // Required -- used for resource naming
 *   namespace: string,           // Required -- where the Backend + HTTPRoute live
 *   gatewayName: string,         // Required
 *   gatewayNamespace: string,    // Required
 *   mcpServiceHost: string,      // Required -- e.g. order-db-mcp.retail-returns.svc.cluster.local
 *   mcpServicePort: number,      // Default: 8080
 *   mcpPath: string,             // Default: /mcp
 *   pathPrefix: string,          // Default: /retail-returns/<serverName>-codemode
 *   cpuTimeout: string,          // Default: '30s'
 *   timeout: string,             // Default: '60s'
 * }
 */
export class McpCodemodeRouteFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.serverName = config.serverName;
    this.gatewayName = config.gatewayName;
    this.gatewayNamespace = config.gatewayNamespace;
    this.mcpServiceHost = config.mcpServiceHost;
    this.mcpServicePort = config.mcpServicePort || 8080;
    this.mcpPath = config.mcpPath || '/mcp';
    this.pathPrefix = config.pathPrefix || `/retail-returns/${this.serverName}-codemode`;
    this.cpuTimeout = config.cpuTimeout || '30s';
    this.timeout = config.timeout || '60s';
    this.backendName = `${this.serverName}-codemode`;
  }

  validate() {
    if (!this.serverName) throw new Error('mcp-codemode-route: serverName is required');
    if (!this.namespace) throw new Error('mcp-codemode-route: namespace is required');
    if (!this.gatewayName) throw new Error('mcp-codemode-route: gatewayName is required');
    if (!this.gatewayNamespace) throw new Error('mcp-codemode-route: gatewayNamespace is required');
    if (!this.mcpServiceHost) throw new Error('mcp-codemode-route: mcpServiceHost is required');
    return true;
  }

  buildBackend() {
    return {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayBackend',
      metadata: {
        name: this.backendName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentic-demo',
          'agentic.demo/feature': this.name,
        },
      },
      spec: {
        entMcp: {
          targets: [
            {
              name: 'default',
              static: {
                host: this.mcpServiceHost,
                path: this.mcpPath,
                port: this.mcpServicePort,
                protocol: 'StreamableHTTP',
              },
            },
          ],
          // codeMode requires toolMode: Code or CodeSearch -- a CEL validation
          // rule on the CRD (confirmed live: applying without it fails with
          // "codeMode may only be set when toolMode is Code or CodeSearch").
          toolMode: 'Code',
          codeMode: { cpuTimeout: this.cpuTimeout, timeout: this.timeout },
        },
      },
    };
  }

  buildHTTPRoute() {
    return {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
      metadata: {
        name: this.backendName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentic-demo',
          'agentic.demo/feature': this.name,
        },
      },
      spec: {
        parentRefs: [{ name: this.gatewayName, namespace: this.gatewayNamespace }],
        rules: [
          {
            matches: [{ path: { type: 'PathPrefix', value: this.pathPrefix } }],
            backendRefs: [
              {
                group: 'enterpriseagentgateway.solo.io',
                kind: 'EnterpriseAgentgatewayBackend',
                name: this.backendName,
              },
            ],
          },
        ],
      },
    };
  }

  async deploy() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.applyResource(this.buildBackend(), context);
      await this.applyResource(this.buildHTTPRoute(), context);
    }
    this.log(
      `codeMode route for MCP server '${this.serverName}' applied at ${this.pathPrefix} (entMcp, codeMode enabled)`,
      'success'
    );
  }

  async cleanup() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.deleteResource('httproute', this.backendName, this.namespace, context);
      await this.deleteResource(
        'enterpriseagentgatewaybackend',
        this.backendName,
        this.namespace,
        context
      );
    }
    this.log(`codeMode route for MCP server '${this.serverName}' removed`, 'success');
  }
}
