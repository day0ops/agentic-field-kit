import { Feature } from '../../../src/lib/feature.js';

/**
 * McpGatewayRouteFeature
 *
 * Fronts an existing MCP server (deployed by kagent-mcp-server, a plain
 * Deployment/Service with no auth of its own - confirmed live: its
 * RemoteMCPServer.spec.url is a bare in-cluster ClusterIP URL kagent-controller
 * calls anonymously) with an agentgateway EnterpriseAgentgatewayBackend +
 * HTTPRoute, so a token-exchange-policy step can apply JWT validation + RFC 8693
 * exchange to it the same way it already does for A2A traffic.
 *
 * UNVERIFIED chain (first time this exact combination is tried in this repo,
 * same risk class as openapi-mcp-backend): spec.entMcp.targets[].static
 * {host,port,path,protocol} is confirmed present on the live CRD schema
 * (`kubectl explain enterpriseagentgatewaybackend.spec.entMcp --recursive`,
 * 2026-11-02) as the shape for wrapping an already-MCP-speaking backend (no
 * OpenAPI translation needed, unlike openapi-mcp-backend's scenario) - but no
 * existing feature in this repo has exercised it live before this one. The
 * HTTPRoute's own path match is just how clients reach this backend through
 * the shared Gateway; the upstream call path is whatever static.path says,
 * independent of the incoming request path (entMcp backends are MCP-protocol-
 * aware, not raw byte-forwarding) - also unverified live before this feature.
 *
 * Unlike substrate-a2a-route's one-shared-Backend-per-controller model (kagent-
 * controller multiplexes many Agents over one Service), each agora-demo MCP
 * server is its own separate Deployment/Service, so this is a 1:1 Backend+
 * HTTPRoute pair per server, matching kagent-mcp-server's own 1:1 model.
 *
 * Configuration:
 * {
 *   serverName: string,        // Required -- must match the kagent-mcp-server
 *                               // instance's own serverName (used for naming and
 *                               // as the default serviceName/routePathPrefix)
 *   namespace: string,         // Required -- where the Backend + HTTPRoute live
 *   serviceName: string,       // Default: serverName -- the MCP server's own
 *                               // Service name (kagent-mcp-server names it after
 *                               // serverName by default)
 *   serviceNamespace: string,  // Default: namespace
 *   port: number,              // Required -- the MCP server's port (must match
 *                               // kagent-mcp-server's own port config)
 *   path: string,              // Default: '/mcp' -- the MCP server's own HTTP
 *                               // transport mount path
 *   gatewayName: string,       // Required
 *   gatewayNamespace: string,  // Required
 *   hostname: string,          // Required -- must match every other HTTPRoute
 *                               // sharing this Gateway (Gateway API resolves
 *                               // routing precedence by hostname specificity
 *                               // before path specificity - a route with no
 *                               // hostnames loses to one with an explicit match
 *                               // regardless of how specific its own path is,
 *                               // confirmed live for substrate-a2a-route)
 *   routePathPrefix: string,   // Default: `/mcp/${serverName}` -- client-facing
 *                               // path prefix on the shared Gateway
 * }
 */
export class McpGatewayRouteFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.serverName = config.serverName;
    this.serviceName = config.serviceName || this.serverName;
    this.serviceNamespace = config.serviceNamespace || this.namespace;
    this.port = config.port;
    this.path = config.path || '/mcp';
    this.gatewayName = config.gatewayName;
    this.gatewayNamespace = config.gatewayNamespace;
    this.hostname = config.hostname;
    this.routePathPrefix = config.routePathPrefix || `/mcp/${this.serverName}`;
    this.backendName = `${this.serverName}-mcp-backend`;
    this.routeName = `${this.serverName}-mcp`;
  }

  validate() {
    if (!this.serverName) throw new Error('mcp-gateway-route: serverName is required');
    if (!this.namespace) throw new Error('mcp-gateway-route: namespace is required');
    if (!this.port) throw new Error('mcp-gateway-route: port is required');
    if (!this.gatewayName) throw new Error('mcp-gateway-route: gatewayName is required');
    if (!this.gatewayNamespace)
      throw new Error('mcp-gateway-route: gatewayNamespace is required');
    if (!this.hostname) throw new Error('mcp-gateway-route: hostname is required');
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
              name: this.serverName,
              static: {
                host: `${this.serviceName}.${this.serviceNamespace}.svc.cluster.local`,
                port: this.port,
                path: this.path,
                protocol: 'StreamableHTTP',
              },
            },
          ],
        },
      },
    };
  }

  buildHTTPRoute() {
    return {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
      metadata: {
        name: this.routeName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentic-demo',
          'agentic.demo/feature': this.name,
        },
      },
      spec: {
        parentRefs: [{ name: this.gatewayName, namespace: this.gatewayNamespace }],
        hostnames: [this.hostname],
        rules: [
          {
            matches: [{ path: { type: 'PathPrefix', value: this.routePathPrefix } }],
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
      `MCP gateway route for '${this.serverName}' applied at ${this.routePathPrefix} (backend '${this.backendName}')`,
      'success'
    );
  }

  async cleanup() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.deleteResource('httproute', this.routeName, this.namespace, context);
      await this.deleteResource(
        'enterpriseagentgatewaybackend',
        this.backendName,
        this.namespace,
        context
      );
    }
    this.log(`MCP gateway route for '${this.serverName}' removed`, 'success');
  }
}
