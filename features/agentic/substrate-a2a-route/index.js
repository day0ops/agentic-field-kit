import { Feature } from '../../../src/lib/feature.js';

/**
 * SubstrateA2ARouteFeature
 *
 * Exposes a Substrate-backed kagent Agent's A2A endpoint through agentgateway, for
 * Agents created via the `substrate-agent` feature (Harness/AgentTemplate/Agent,
 * api.kagent.dev/v1alpha3). Unlike `agentgateway-a2a-route` (built for standalone
 * BYO agents, each with its own Kubernetes Service), a Substrate-backed Agent has NO
 * per-agent Service at all -- confirmed live, 2026-11-01: `kubectl get svc`/`get
 * endpointslices` in the Agent's namespace return nothing matching it. Every such
 * Agent runs as an Actor multiplexed onto a shared WorkerPool, and is reached only
 * through kagent-controller's own shared, path-based A2A mux
 * (`/agents/<namespace>/<name>`). `agentgateway-a2a-route`'s model -- a per-agent
 * {host,port} Backend plus a URLRewrite stripping the path to `/` -- is structurally
 * incompatible with this: there is no per-agent host:port to point at, and the
 * controller needs the full path to resolve which Agent a request addresses.
 *
 * Routes instead through ONE shared EnterpriseAgentgatewayBackend pointing at
 * kagent-controller's own Service, with a path-PRESERVING HTTPRoute per Agent (no
 * rewrite). Applying this feature for multiple Agents behind the same controller
 * reuses the same Backend object (named after the controller, not the agent) --
 * re-applying identical content is idempotent.
 *
 * Configuration:
 * {
 *   agentName: string,              // Required -- the Agent CR's name; used for the route
 *                                     // path and this feature's own HTTPRoute naming
 *   agentNamespace: string,         // Default: this.namespace -- the Agent CR's own
 *                                     // namespace, used in the route path. kagent-controller's
 *                                     // path grammar is /agents/<namespace>/<name> regardless
 *                                     // of where this feature's own gateway resources live.
 *   namespace: string,              // Required -- where the Backend + HTTPRoute live
 *   gatewayName: string,            // Required
 *   gatewayNamespace: string,       // Required
 *   controllerServiceName: string,  // Default: 'kagent-controller'
 *   controllerNamespace: string,    // Default: this.namespace -- kagent-controller's own
 *                                     // Service namespace, if different from where this
 *                                     // feature's HTTPRoute/Backend are applied
 *   controllerPort: number,         // Default: 8083
 *   hostname: string,                // Optional -- sets the HTTPRoute's spec.hostnames. Required
 *                                     // whenever another HTTPRoute on the same Gateway sets an
 *                                     // explicit hostname (e.g. the console's own route): Gateway
 *                                     // API resolves routing precedence by hostname specificity
 *                                     // BEFORE path specificity, so a route with no hostnames
 *                                     // (implicitly "*") loses to one with an explicit match even
 *                                     // when its own path match is far more specific -- confirmed
 *                                     // live, 2026-11-01: every request to this route's own path
 *                                     // was instead captured by the console's catch-all `/` route
 *                                     // and its oidc-gate policy until this was set.
 * }
 */
export class SubstrateA2ARouteFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.agentName = config.agentName;
    this.agentNamespace = config.agentNamespace || this.namespace;
    this.gatewayName = config.gatewayName;
    this.gatewayNamespace = config.gatewayNamespace;
    this.controllerServiceName = config.controllerServiceName || 'kagent-controller';
    this.controllerNamespace = config.controllerNamespace || this.namespace;
    this.controllerPort = config.controllerPort || 8083;
    this.hostname = config.hostname || null;
    this.backendName = `${this.controllerServiceName}-a2a`;
    this.routeName = `${this.agentName}-a2a`;
    this.pathPrefix = `/agents/${this.agentNamespace}/${this.agentName}`;
  }

  validate() {
    if (!this.agentName) throw new Error('substrate-a2a-route: agentName is required');
    if (!this.namespace) throw new Error('substrate-a2a-route: namespace is required');
    if (!this.gatewayName) throw new Error('substrate-a2a-route: gatewayName is required');
    if (!this.gatewayNamespace)
      throw new Error('substrate-a2a-route: gatewayNamespace is required');
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
        a2a: {
          host: `${this.controllerServiceName}.${this.controllerNamespace}.svc.cluster.local`,
          port: this.controllerPort,
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
        ...(this.hostname && { hostnames: [this.hostname] }),
        rules: [
          {
            // No URLRewrite: kagent-controller's own path-based mux needs the full
            // /agents/<namespace>/<name> path to resolve which Agent this is.
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
      `A2A route for Substrate Agent '${this.agentName}' applied at ${this.pathPrefix} (no rewrite, shared backend '${this.backendName}')`,
      'success'
    );
  }

  async cleanup() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.deleteResource('httproute', this.routeName, this.namespace, context);
      // Shared across every Agent behind the same controller -- deleting it once per
      // Agent instance is redundant but harmless (deleteResource already ignores
      // not-found).
      await this.deleteResource(
        'enterpriseagentgatewaybackend',
        this.backendName,
        this.namespace,
        context
      );
    }
    this.log(`A2A route for Substrate Agent '${this.agentName}' removed`, 'success');
  }
}
