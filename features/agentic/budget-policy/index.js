import { Feature } from '../../../src/lib/feature.js';

/**
 * BudgetPolicyFeature
 *
 * Applies:
 * - one EnterpriseAgentgatewayBudget (a list of named budget entries, each
 *   with its own subject/limit/window/onBudgetExceeded)
 * - one EnterpriseAgentgatewayPolicy carrying both spec.traffic.jwtAuthentication
 *   (mode: Permissive) and spec.traffic.entBudgetEnforcement, targeting the LLM
 *   backend's own HTTPRoute (e.g. 'openai', the one the providers feature
 *   creates). spec.traffic.* can only target a Gateway/ListenerSet/GRPCRoute/
 *   HTTPRoute/Service/ServiceEntry -- NOT an EnterpriseAgentgatewayBackend,
 *   confirmed live (the CRD's admission webhook rejects it outright) -- so
 *   both traffic-level policies live on the route, not the backend, and are
 *   combined into a single object rather than two separate ones targeting
 *   the same route.
 *   - jwtAuthentication is required because the budgets' subject dimension
 *     resolves from a JWT claim (jwt.email), and the shared openai route has
 *     no JWT validation attached by default. `mode: Permissive` decodes a JWT
 *     when present but allows requests with a missing OR invalid one through
 *     unchanged -- required (not `Optional`, which only tolerates a *missing*
 *     token) because the 4 existing agents send a real, non-empty
 *     `Authorization: Bearer unused-real-auth-at-agentgateway` header on
 *     every LLM call (see OPENAI_API_KEY in the app manifest), which is
 *     present-but-invalid, not absent -- confirmed live: `Optional` mode
 *     rejected these calls with 401, breaking Stage 3/7 entirely. Only this
 *     feature's own customer-authenticated "make a paid call" traffic carries
 *     a real JWT.
 *   - entBudgetEnforcement.discovery.namespaces is what turns budget
 *     enforcement on for this route, discovering Budget resources from the
 *     configured namespace scope. The Budget CRD itself has no targetRefs at
 *     all.
 *
 * Stage 6 of the guided tour (budget control): two budget entries, same
 * mechanism, different onBudgetExceeded modes (Block vs Audit), each scoped
 * to a different demo customer via the customerEmail request dimension
 * (jwt.email -- see addons/agentgateway/config/values.yaml's budgetDimensions
 * override; jwt.sub can't be used since Keycloak's UUID isn't known ahead of
 * deploy time).
 *
 * Configuration:
 * {
 *   policyName: string,     // Required
 *   budgetName: string,     // Required
 *   namespace: string,      // Default: 'agentgateway-proxy'
 *   llmHttpRoute: string,   // Required -- HTTPRoute name, e.g. 'openai'
 *   discoveryFrom: string,  // Default: 'Same' -- All|Same|Selector
 *   budgets: [{             // Required, non-empty
 *     name: string,
 *     subject: object,      // map[string]string, e.g. { customerEmail: '...' }
 *     limit: { amount: number, unit: 'USD'|'Tokens' },
 *     window: { unit: 'Day'|'Week'|'Month'|'Year' },
 *     onBudgetExceeded: 'Block'|'Audit',
 *   }],
 *   jwtIssuer: string,       // Required -- e.g. https://<keycloak>/realms/<realm>
 *   jwksPath: string,        // Required
 *   keycloak: { serviceName?: string, namespace: string, port?: number },
 * }
 */
export class BudgetPolicyFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.namespace = config.namespace || 'agentgateway-proxy';
    this.policyName = config.policyName;
    this.budgetName = config.budgetName;
    this.llmHttpRoute = config.llmHttpRoute;
    this.discoveryFrom = config.discoveryFrom || 'Same';
    this.budgets = config.budgets || [];
    this.jwtIssuer = config.jwtIssuer;
    this.jwksPath = config.jwksPath;
    const keycloak = config.keycloak || {};
    this.keycloakServiceName = keycloak.serviceName || 'keycloak';
    this.keycloakNamespace = keycloak.namespace;
    this.keycloakPort = keycloak.port || 8080;
  }

  validate() {
    if (!this.policyName) throw new Error('budget-policy: policyName is required');
    if (!this.budgetName) throw new Error('budget-policy: budgetName is required');
    if (!this.llmHttpRoute) throw new Error('budget-policy: llmHttpRoute is required');
    if (this.budgets.length === 0)
      throw new Error('budget-policy: budgets is required (non-empty)');
    if (!this.jwtIssuer) throw new Error('budget-policy: jwtIssuer is required');
    if (!this.jwksPath) throw new Error('budget-policy: jwksPath is required');
    if (!this.keycloakNamespace) throw new Error('budget-policy: keycloak.namespace is required');
    return true;
  }

  keycloakBackendRef() {
    return {
      name: this.keycloakServiceName,
      namespace: this.keycloakNamespace,
      port: this.keycloakPort,
    };
  }

  buildBudget() {
    return {
      apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
      kind: 'EnterpriseAgentgatewayBudget',
      metadata: {
        name: this.budgetName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentic-demo',
          'agentic.demo/feature': this.name,
        },
      },
      spec: {
        budgets: this.budgets,
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
          { group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: this.llmHttpRoute },
        ],
        traffic: {
          jwtAuthentication: {
            mode: 'Permissive',
            providers: [
              {
                issuer: this.jwtIssuer,
                jwks: {
                  remote: {
                    backendRef: this.keycloakBackendRef(),
                    jwksPath: this.jwksPath,
                  },
                },
              },
            ],
          },
          entBudgetEnforcement: {
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
      await this.applyResource(this.buildBudget(), context);
      await this.applyResource(this.buildTrafficPolicy(), context);
      this.log(
        `Budget '${this.budgetName}' (${this.budgets.length} entr${this.budgets.length === 1 ? 'y' : 'ies'}) ` +
          `and traffic policy '${this.policyName}' applied, targeting HTTPRoute '${this.llmHttpRoute}' ` +
          `(JWT validation: Permissive mode)`,
        'success'
      );
    }
  }

  async cleanup() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.deleteResource(
        'enterpriseagentgatewaypolicy',
        this.policyName,
        this.namespace,
        context
      );
      await this.deleteResource(
        'enterpriseagentgatewaybudget',
        this.budgetName,
        this.namespace,
        context
      );
    }
    this.log(`Budget '${this.budgetName}' and its traffic policy removed`, 'success');
  }
}
