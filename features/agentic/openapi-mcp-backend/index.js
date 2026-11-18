import { Feature } from '../../../src/lib/feature.js';

/**
 * OpenapiMcpBackendFeature
 *
 * Exposes an existing REST API's OpenAPI schema as an MCP tool source for a
 * Substrate AgentTemplate, via agentgateway Enterprise's OpenAPI-as-MCP
 * capability (listings-mcp's intended mechanism per
 * docs/superpowers/specs/2026-10-30-marketplace-demo-design.md section 5.2 -
 * this historical doc predates the day0ops/agora-demo repo rename).
 *
 * UNVERIFIED chain, in increasing order of uncertainty:
 * - ConfigMap: confirmed pattern (see addons/agentregistry/index.js's
 *   OTel-collector config), just storing a schema document instead.
 * - EnterpriseAgentgatewayBackend with spec.entMcp: the CRD kind and the
 *   top-level spec.entMcp field are confirmed (see
 *   features/traffic-management/agentgateway-backend/index.js, which puts
 *   enterprise MCP config there verbatim with no internal validation). The
 *   `openapi.configMapRef` sub-shape used here is NOT confirmed -- no
 *   existing feature demonstrates an OpenAPI-sourced entMcp backend, and
 *   this repo's one generic backend-builder takes an opaque blob with no
 *   shape of its own to confirm against. This also deliberately does NOT
 *   use the design doc's asserted `spec.backend.mcp.openapi` path, which
 *   contradicts the confirmed `spec.entMcp` convention above.
 * - HTTPRoute pointing at the backend: UNVERIFIED. EnterpriseAgentgatewayBackend
 *   objects are consumed as route backends elsewhere in this repo (not bound
 *   directly by an AgentTemplate), so an HTTPRoute is assumed necessary, but
 *   no existing feature pairs HTTPRoute + EnterpriseAgentgatewayBackend.
 * - RemoteMCPServer.spec.url pointing at the HTTPRoute's hostname: UNVERIFIED.
 *   kagent-mcp-server's RemoteMCPServer always points at a plain ClusterIP
 *   Service URL; no existing feature points one at a Gateway-routed hostname
 *   instead. This is what should let a Substrate AgentTemplate bind this
 *   backend via the same tools: [{ mcp: name }] mechanism as any other MCP
 *   tool, with no special-casing in substrate-agent -- but that end-to-end
 *   path has not been exercised against a real cluster.
 *
 * Expect this feature to need correction the first time it's applied to a
 * real cluster with real agentgateway Enterprise CRDs installed.
 *
 * Configuration:
 * {
 *   backendName: string,              // Required
 *   namespace: string,                // Default: 'agentgateway-proxy'
 *   openapiSchema: string,            // Required -- the OpenAPI document content
 *   hostname: string,                 // Required -- hostname for the HTTPRoute
 *   gatewayName: string,              // Required -- parent Gateway for the HTTPRoute
 *   remoteMcpServerName: string,      // Default: backendName
 *   remoteMcpServerNamespace: string, // Default: namespace -- may differ, since the
 *                                     // RemoteMCPServer must live in the same namespace
 *                                     // as the consuming AgentTemplate
 * }
 */
export class OpenapiMcpBackendFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.namespace = config.namespace || 'agentgateway-proxy';
    this.backendName = config.backendName;
    this.openapiSchema = config.openapiSchema;
    this.hostname = config.hostname;
    this.gatewayName = config.gatewayName;
    this.remoteMcpServerName = config.remoteMcpServerName || this.backendName;
    this.remoteMcpServerNamespace = config.remoteMcpServerNamespace || this.namespace;
  }

  validate() {
    if (!this.backendName) throw new Error('openapi-mcp-backend: backendName is required');
    if (!this.openapiSchema) throw new Error('openapi-mcp-backend: openapiSchema is required');
    if (!this.hostname) throw new Error('openapi-mcp-backend: hostname is required');
    if (!this.gatewayName) throw new Error('openapi-mcp-backend: gatewayName is required');
    return true;
  }

  get configMapName() {
    return `${this.backendName}-openapi-schema`;
  }

  buildConfigMap() {
    return {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: this.configMapName,
        namespace: this.namespace,
        labels: { 'app.kubernetes.io/managed-by': 'agentic-demo' },
      },
      data: { 'openapi.yaml': this.openapiSchema },
    };
  }

  buildBackend() {
    return {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayBackend',
      metadata: {
        name: this.backendName,
        namespace: this.namespace,
        labels: { 'app.kubernetes.io/managed-by': 'agentic-demo' },
      },
      spec: {
        // UNVERIFIED: the openapi.configMapRef sub-shape under entMcp is new
        // ground, not confirmed against any existing feature or a live cluster -
        // see this file's class doc comment.
        entMcp: {
          openapi: {
            configMapRef: { name: this.configMapName },
          },
        },
      },
    };
  }

  buildHTTPRoute() {
    return {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
      metadata: { name: this.backendName, namespace: this.namespace },
      spec: {
        parentRefs: [
          { group: 'gateway.networking.k8s.io', kind: 'Gateway', name: this.gatewayName },
        ],
        hostnames: [this.hostname],
        rules: [
          {
            matches: [{ path: { type: 'PathPrefix', value: '/' } }],
            // UNVERIFIED: pairing an HTTPRoute with an EnterpriseAgentgatewayBackend
            // backendRef is not demonstrated by any existing feature in this repo.
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

  buildRemoteMcpServer() {
    return {
      apiVersion: 'api.kagent.dev/v1alpha3',
      kind: 'RemoteMCPServer',
      metadata: {
        name: this.remoteMcpServerName,
        namespace: this.remoteMcpServerNamespace,
        labels: { 'app.kubernetes.io/managed-by': 'agentic-demo' },
      },
      spec: {
        description: `MCP server '${this.remoteMcpServerName}' (OpenAPI-sourced)`,
        // UNVERIFIED: pointing RemoteMCPServer.spec.url at a Gateway-routed
        // hostname (rather than a plain ClusterIP Service URL, kagent-mcp-server's
        // only confirmed pattern) is not demonstrated anywhere in this repo.
        url: `https://${this.hostname}/mcp`,
        protocol: 'STREAMABLE_HTTP',
      },
    };
  }

  async deploy() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.applyResource(this.buildConfigMap(), context);
      await this.applyResource(this.buildBackend(), context);
      await this.applyResource(this.buildHTTPRoute(), context);
      await this.applyResource(this.buildRemoteMcpServer(), context);
      this.log(
        `openapi-mcp-backend '${this.backendName}' applied (ConfigMap + Backend + HTTPRoute + RemoteMCPServer)`,
        'success'
      );
    }
  }

  async cleanup() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.deleteResource(
        'remotemcpservers.api.kagent.dev',
        this.remoteMcpServerName,
        this.remoteMcpServerNamespace,
        context
      );
      await this.deleteResource('httproute', this.backendName, this.namespace, context);
      await this.deleteResource(
        'enterpriseagentgatewaybackend',
        this.backendName,
        this.namespace,
        context
      );
      await this.deleteResource('configmap', this.configMapName, this.namespace, context);
    }
    this.log(`openapi-mcp-backend '${this.backendName}' cleaned up`, 'success');
  }
}
