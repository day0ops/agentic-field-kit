import { Feature } from '../../../src/lib/feature.js';

/**
 * KagentMcpServerFeature
 *
 * By default, deploys a containerised MCP server (Deployment + Service) plus
 * a `RemoteMCPServer` (api.kagent.dev/v1alpha3) pointing at it, so a Substrate
 * AgentTemplate (substrate-agent's `tools: [{ mcp: serverName }]`) can bind
 * its tools -- CEL-validated to require `kind: RemoteMCPServer` with
 * `apiGroup` entirely absent; binding anything else is rejected at admission.
 *
 * kagent no longer ships a native `MCPServer` CRD on the 1.0.0-alpha12+ chart
 * line (removed -- confirmed by its absence from both the CRD template set
 * and the Go API packages at alpha12's pinned kagent commit; upstream's own
 * examples, e.g. contrib/tools/k8sgpt-mcp-server/, now deploy a plain
 * Deployment/Service and point a RemoteMCPServer at it). This feature
 * therefore deploys and owns the backing pod itself by default, the same way
 * this repo's own `mcp-server` feature already does, rather than asking
 * kagent to deploy it from an MCPServer spec.
 *
 * `legacyNativeMcpServer: true` restores the pre-alpha12 behavior (a native
 * `MCPServer` CR at `kagent.dev/v1alpha1`, with the `kagent.solo.io/waypoint`
 * label kagent needs to provision the Istio ambient waypoint an AccessPolicy
 * attaches to, plus a `RemoteMCPServer` at the matching `kagent.dev/v1alpha3`)
 * for usecases still pinned to an older kagent chart -- e.g.
 * retail-returns-demo.yaml targets aws-dev's kagent 0.5.6, a different
 * environment/cloud than the alpha12 GKE substrate profiles, and its Stage 11
 * AccessPolicy only resolves a `targetRef.kind: MCPServer` against a real
 * `MCPServer.kagent.dev` object -- there is no equivalent targeting for a
 * plain Deployment.
 *
 * Configuration:
 * {
 *   serverName: string,      // Required -- resource name (Deployment/Service or MCPServer, + RemoteMCPServer)
 *   namespace: string,       // Default: 'kagent-system'
 *   image: string,           // Required -- container image
 *   port: number,            // Default: 8080 -- container + Service + MCP path port
 *   path: string,            // Default: '/mcp' -- HTTP transport mount path
 *   description: string,     // Default: `MCP server '<serverName>'` -- RemoteMCPServer.spec.description (required by its CRD)
 *   legacyNativeMcpServer: boolean, // Default: false -- true targets kagent < 1.0.0-alpha12's native MCPServer CRD instead
 *   env: [{name: string, value: string}], // Optional -- extra container env vars, e.g. CATALOG_API_URL.
 *                                          // Only applies to the default (non-legacy) Deployment path -
 *                                          // ignored when legacyNativeMcpServer is true.
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
    this.legacyNativeMcpServer = config.legacyNativeMcpServer === true;
    this.env = config.env || [];
  }

  validate() {
    if (!this.serverName) throw new Error('kagent-mcp-server: serverName is required');
    if (!this.image) throw new Error('kagent-mcp-server: image is required');
    return true;
  }

  // Legacy path (kagent < 1.0.0-alpha12 only): kagent itself deploys and owns the pod
  // from this spec. The 'kagent.solo.io/waypoint' label is required for kagent to
  // provision the Istio ambient waypoint (mcpserver-<name>-waypoint) that AccessPolicy
  // enforcement attaches to -- without it the server deploys fine but no AccessPolicy
  // targeting it can ever attach.
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

  buildDeployment() {
    return {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: this.serverName,
        namespace: this.namespace,
        labels: { 'app.kubernetes.io/managed-by': 'agentic-demo', app: this.serverName },
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: this.serverName } },
        template: {
          metadata: { labels: { app: this.serverName } },
          spec: {
            containers: [
              {
                name: this.serverName,
                image: this.image,
                ports: [{ containerPort: this.port }],
                ...(this.env.length > 0 ? { env: this.env } : {}),
                readinessProbe: {
                  tcpSocket: { port: this.port },
                  initialDelaySeconds: 10,
                  periodSeconds: 5,
                },
              },
            ],
          },
        },
      },
    };
  }

  buildService() {
    return {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: this.serverName,
        namespace: this.namespace,
        labels: { 'app.kubernetes.io/managed-by': 'agentic-demo', app: this.serverName },
      },
      spec: {
        selector: { app: this.serverName },
        ports: [{ name: 'mcp', protocol: 'TCP', port: this.port, targetPort: this.port }],
        type: 'ClusterIP',
      },
    };
  }

  buildRemoteMcpServer() {
    return {
      apiVersion: this.legacyNativeMcpServer ? 'kagent.dev/v1alpha3' : 'api.kagent.dev/v1alpha3',
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
      if (this.legacyNativeMcpServer) {
        await this.applyResource(this.buildMcpServer(), context);
      } else {
        await this.applyResource(this.buildDeployment(), context);
        await this.applyResource(this.buildService(), context);
      }
      await this.applyResource(this.buildRemoteMcpServer(), context);
      this.log(
        `MCP server '${this.serverName}' (${this.legacyNativeMcpServer ? 'native MCPServer' : 'Deployment + Service'}) + RemoteMCPServer applied in namespace '${this.namespace}'`,
        'success'
      );
    }
  }

  async cleanup() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      // Fully-qualified: AgentRegistry has its own unrelated ar.dev/v1alpha1 MCPServer
      // kind, so a bare 'mcpserver'/'remotemcpserver' is ambiguous on any cluster
      // running both -- kubectl could resolve to the wrong one and silently no-op
      // (caught by --ignore-not-found), orphaning the kagent-native resource.
      await this.deleteResource(
        this.legacyNativeMcpServer ? 'remotemcpservers.kagent.dev' : 'remotemcpservers.api.kagent.dev',
        this.serverName,
        this.namespace,
        context
      );
      if (this.legacyNativeMcpServer) {
        await this.deleteResource('mcpservers.kagent.dev', this.serverName, this.namespace, context);
      } else {
        await this.deleteResource('service', this.serverName, this.namespace, context);
        await this.deleteResource('deployment', this.serverName, this.namespace, context);
      }
    }
    this.log(`kagent-mcp-server '${this.serverName}' cleaned up`, 'success');
  }
}

export function createKagentMcpServerFeature(config) {
  return new KagentMcpServerFeature('kagent-mcp-server', config);
}
