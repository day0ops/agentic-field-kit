import { Feature } from '../../../src/lib/feature.js';

/**
 * RateLimitPolicyFeature
 *
 * UNVERIFIED: this feature's entire CRD shape (the `RateLimitConfig` kind,
 * and `EnterpriseAgentgatewayPolicy.spec.traffic.entRateLimit`) is asserted
 * only by docs/superpowers/specs/2026-10-30-marketplace-demo-design.md (a
 * historical doc predating the day0ops/agora-demo repo rename) - it
 * does not appear anywhere else in this repo's code, and is not confirmed
 * against a live agentgateway Enterprise cluster. It is modeled directly on
 * the one confirmed sibling pattern this repo has for "named traffic-policy
 * resource discovered by an EnterpriseAgentgatewayPolicy" -
 * budget-policy's EnterpriseAgentgatewayBudget + entBudgetEnforcement - by
 * analogy only. Expect this to need correction the first time it's applied
 * to a real cluster.
 *
 * Applies:
 * - one RateLimitConfig (a list of named limit entries, each with its own
 *   subject/requestsPerUnit/unit) -- UNVERIFIED kind/shape.
 * - one EnterpriseAgentgatewayPolicy carrying spec.traffic.entRateLimit,
 *   targeting an HTTPRoute -- UNVERIFIED field name under spec.traffic.
 *   Per budget-policy's own confirmed finding, spec.traffic.* can only
 *   target a Gateway/ListenerSet/GRPCRoute/HTTPRoute/Service/ServiceEntry,
 *   never an EnterpriseAgentgatewayBackend directly -- by the same `spec.traffic`
 *   family naming, entRateLimit is assumed bound by the same constraint,
 *   though this specific point is inference, not confirmed.
 *
 * Unlike budget-policy, no jwtAuthentication companion wiring is built by
 * default here: budget-policy needs it because its subject dimension
 * resolves from a JWT claim (jwt.email) on a route with no JWT validation
 * attached by default. Whether rate-limit's subject dimension needs the same
 * treatment depends on what that dimension actually resolves from once the
 * real CRD shape is confirmed -- deliberately left as a follow-up rather
 * than guessed at now.
 *
 * Configuration:
 * {
 *   policyName: string,            // Required
 *   rateLimitConfigName: string,   // Required
 *   namespace: string,             // Default: 'agentgateway-proxy'
 *   targetHttpRoute: string,       // Required -- HTTPRoute name to rate-limit
 *   discoveryFrom: string,         // Default: 'Same' -- All|Same|Selector
 *   limits: [{                     // Required, non-empty
 *     name: string,
 *     subject: object,             // map[string]string
 *     requestsPerUnit: number,
 *     unit: 'Second'|'Minute'|'Hour',
 *   }],
 * }
 */
export class RateLimitPolicyFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.namespace = config.namespace || 'agentgateway-proxy';
    this.policyName = config.policyName;
    this.rateLimitConfigName = config.rateLimitConfigName;
    this.targetHttpRoute = config.targetHttpRoute;
    this.discoveryFrom = config.discoveryFrom || 'Same';
    this.limits = config.limits || [];
  }

  validate() {
    if (!this.policyName) throw new Error('rate-limit-policy: policyName is required');
    if (!this.rateLimitConfigName) throw new Error('rate-limit-policy: rateLimitConfigName is required');
    if (!this.targetHttpRoute) throw new Error('rate-limit-policy: targetHttpRoute is required');
    if (this.limits.length === 0) throw new Error('rate-limit-policy: limits is required (non-empty)');
    return true;
  }

  buildRateLimitConfig() {
    return {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      // UNVERIFIED: 'RateLimitConfig' kind and apiVersion are asserted only by
      // the design doc, not confirmed against this repo or a live cluster.
      kind: 'RateLimitConfig',
      metadata: {
        name: this.rateLimitConfigName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentic-demo',
          'agentic.demo/feature': this.name,
        },
      },
      spec: {
        limits: this.limits,
      },
    };
  }

  buildTrafficPolicy() {
    return {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayPolicy',
      metadata: {
        name: this.policyName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentic-demo',
          'agentic.demo/feature': this.name,
        },
      },
      spec: {
        targetRefs: [
          { group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: this.targetHttpRoute },
        ],
        traffic: {
          // UNVERIFIED: 'entRateLimit' field name under spec.traffic is asserted
          // only by the design doc - see this file's class doc comment.
          entRateLimit: {
            discovery: {
              namespaces: { from: this.discoveryFrom },
            },
          },
        },
      },
    };
  }

  async deploy() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.applyResource(this.buildRateLimitConfig(), context);
      await this.applyResource(this.buildTrafficPolicy(), context);
      this.log(
        `RateLimitConfig '${this.rateLimitConfigName}' and traffic policy '${this.policyName}' applied, targeting HTTPRoute '${this.targetHttpRoute}'`,
        'success'
      );
    }
  }

  async cleanup() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.deleteResource('enterpriseagentgatewaypolicy', this.policyName, this.namespace, context);
      await this.deleteResource('ratelimitconfig', this.rateLimitConfigName, this.namespace, context);
    }
    this.log(`RateLimitConfig '${this.rateLimitConfigName}' and its traffic policy removed`, 'success');
  }
}
