import { Feature } from '../../../src/lib/feature.js';

/**
 * AgentgatewayA2ARouteFeature
 *
 * Exposes a kagent BYO agent's native A2A server (port 8080, JSON-RPC mounted
 * at its root `/`, agent card at `/.well-known/agent.json`) through agentgateway,
 * so another agent can reach it via `kagent-dev/kagent/go/adk/pkg/tools.NewKAgentRemoteA2ATool`
 * instead of calling its cluster-internal Service directly.
 *
 * Applies two resources:
 *   1. An EnterpriseAgentgatewayBackend (spec.a2a: {host, port}) pointing at the
 *      agent's own Kubernetes Service.
 *   2. An HTTPRoute exposing that Backend at pathPrefix, with a URLRewrite
 *      stripping the prefix down to `/` — same shape as the `providers` feature's
 *      `/openai` route — so both the JSON-RPC endpoint and the agent-card path
 *      resolve correctly through the prefix.
 *
 * Checked live before writing this (2026-08-27): no agent in this repo — retail-returns
 * or finflow — has ever had this wiring; finflow's *_AGENT_URL env vars reference
 * `/agents/<name>` paths that were never backed by any HTTPRoute/Backend. This is new,
 * unproven ground, not a copy of an existing pattern.
 *
 * Configuration:
 * {
 *   agentName: string,          // Required — used for resource naming and the default pathPrefix
 *   namespace: string,          // Required — where the Backend + HTTPRoute live (matches this
 *                                // repo's convention of colocating agentgateway config with the
 *                                // gateway itself, e.g. agentgateway-proxy)
 *   gatewayName: string,        // Required
 *   gatewayNamespace: string,   // Required
 *   agentServiceHost: string,   // Required — the agent's own Service DNS name, e.g.
 *                                // order-lookup-agent.retail-returns.svc.cluster.local
 *   agentServicePort: number,   // Default: 8080
 *   pathPrefix: string,         // Default: /agents/<agentName>
 * }
 */
export class AgentgatewayA2ARouteFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.agentName = config.agentName;
    this.gatewayName = config.gatewayName;
    this.gatewayNamespace = config.gatewayNamespace;
    this.agentServiceHost = config.agentServiceHost;
    this.agentServicePort = config.agentServicePort || 8080;
    this.pathPrefix = config.pathPrefix || `/agents/${this.agentName}`;
    this.backendName = `${this.agentName}-a2a`;
  }

  validate() {
    if (!this.agentName) throw new Error('agentgateway-a2a-route: agentName is required');
    if (!this.namespace) throw new Error('agentgateway-a2a-route: namespace is required');
    if (!this.gatewayName) throw new Error('agentgateway-a2a-route: gatewayName is required');
    if (!this.gatewayNamespace)
      throw new Error('agentgateway-a2a-route: gatewayNamespace is required');
    if (!this.agentServiceHost)
      throw new Error('agentgateway-a2a-route: agentServiceHost is required');
    return true;
  }

  buildBackend() {
    return this.#backendResource(this.backendName);
  }

  /**
   * A separate Backend object for the card route, identical target -- backend.auth
   * (token exchange) is scoped to the Backend object, not the route: confirmed live
   * that even after excluding the card route from JWT targetRefs, it still failed
   * ("oauth token exchange subject token missing") because it shared the same
   * <name>-a2a Backend as the main route, and that Backend is targeted by the
   * exchange policy. Giving the card route its own Backend (not in the exchange
   * policy's targetRefs) is what actually makes it exchange-free, not just JWT-free.
   */
  buildCardBackend() {
    return this.#backendResource(`${this.backendName}-card`);
  }

  #backendResource(name) {
    return {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayBackend',
      metadata: {
        name,
        namespace: this.namespace,
        labels: { 'app.kubernetes.io/managed-by': 'agentic-demo', 'agentic.demo/feature': this.name },
      },
      spec: {
        a2a: { host: this.agentServiceHost, port: this.agentServicePort },
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
        labels: { 'app.kubernetes.io/managed-by': 'agentic-demo', 'agentic.demo/feature': this.name },
      },
      spec: {
        parentRefs: [{ name: this.gatewayName, namespace: this.gatewayNamespace }],
        rules: [
          {
            matches: [{ path: { type: 'PathPrefix', value: this.pathPrefix } }],
            filters: [
              {
                type: 'URLRewrite',
                urlRewrite: { path: { type: 'ReplacePrefixMatch', replacePrefixMatch: '/' } },
              },
            ],
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

  /**
   * A separate HTTPRoute, deliberately NOT included in token-exchange-policy's JWT
   * targetRefs, so `<pathPrefix>/.well-known/*` resolves without auth. Required
   * because kagent's NewKAgentRemoteA2ATool fetches the remote agent's card from
   * this path using a plain http.Client — propagateToken only wires the customer's
   * JWT into the actual message/send call's interceptors, not the card-resolution
   * request, confirmed live: with the whole pathPrefix under Strict JWT enforcement,
   * every outbound A2A call failed at the card-fetch step with a bare 401 before ever
   * attempting the real RPC. Matches the general convention of unauthenticated
   * `.well-known` discovery documents (e.g. `.well-known/openid-configuration`) --
   * the card is public metadata, only the RPC itself needs the caller's identity.
   * Gateway API resolves the more specific path match first, so this route (longer
   * prefix) takes precedence over buildHTTPRoute()'s bare pathPrefix for anything
   * under `.well-known`.
   */
  buildAgentCardHTTPRoute() {
    const wellKnownPrefix = `${this.pathPrefix}/.well-known`;
    return {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
      metadata: {
        name: `${this.backendName}-card`,
        namespace: this.namespace,
        labels: { 'app.kubernetes.io/managed-by': 'agentic-demo', 'agentic.demo/feature': this.name },
      },
      spec: {
        parentRefs: [{ name: this.gatewayName, namespace: this.gatewayNamespace }],
        rules: [
          {
            matches: [{ path: { type: 'PathPrefix', value: wellKnownPrefix } }],
            filters: [
              {
                type: 'URLRewrite',
                urlRewrite: { path: { type: 'ReplacePrefixMatch', replacePrefixMatch: '/.well-known' } },
              },
            ],
            backendRefs: [
              {
                group: 'enterpriseagentgateway.solo.io',
                kind: 'EnterpriseAgentgatewayBackend',
                name: `${this.backendName}-card`,
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
      await this.applyResource(this.buildCardBackend(), context);
      await this.applyResource(this.buildHTTPRoute(), context);
      await this.applyResource(this.buildAgentCardHTTPRoute(), context);
    }
    this.log(
      `A2A route for agent '${this.agentName}' applied at ${this.pathPrefix} (rewrite → /), card route unauthenticated at ${this.pathPrefix}/.well-known`,
      'success'
    );
  }

  async cleanup() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.deleteResource('httproute', `${this.backendName}-card`, this.namespace, context);
      await this.deleteResource('httproute', this.backendName, this.namespace, context);
      await this.deleteResource(
        'enterpriseagentgatewaybackend',
        `${this.backendName}-card`,
        this.namespace,
        context
      );
      await this.deleteResource(
        'enterpriseagentgatewaybackend',
        this.backendName,
        this.namespace,
        context
      );
    }
    this.log(`A2A route for agent '${this.agentName}' removed`, 'success');
  }
}
