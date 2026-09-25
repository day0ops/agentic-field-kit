import { Feature } from '../../../src/lib/feature.js';

/**
 * EntraOboPolicyFeature
 *
 * Applies spec.backend.tokenExchange.entra (mode: ExchangeOnly) targeting one
 * EnterpriseAgentgatewayBackend -- a direct, silent Microsoft Entra On-Behalf-Of
 * exchange with no interactive elicitation/consent screen, no per-user cached
 * credential. Matches Solo's own documented Entra OBO guide
 * (docs.solo.io/agentgateway/.../mcp/token-exchange/obo/obo-entra/) field-for-field:
 * spec.backend.tokenExchange.entra {tenantId, clientId, scope, clientSecretRef},
 * no backendRef (the gateway's internal STS calls Entra's real OBO endpoint
 * directly -- distinct from spec.backend.entTokenExchange.entra, a separate, newer
 * multi-provider mechanism this repo tried first and abandoned: its CRD type never
 * exposes a subjectToken source override, so it can only read the incoming
 * assertion from the raw Authorization header).
 *
 * Two prerequisites this feature does NOT manage, both required for this to work
 * at all (see the class-level notes below and the doc's Steps 1-5):
 *
 * 1. The gateway's own STS needs an Entra-aware subjectValidator/apiValidator
 *    entry -- a Helm-level change to the shared enterprise-agentgateway release
 *    (tokenExchange.subjectValidators[]/apiValidators[], which already carries a
 *    retail-returns-customers Keycloak entry live -- append, never replace).
 * 2. The target Backend's route must NOT be covered by a traffic.jwtAuthentication
 *    policy that strips the Authorization header before this policy's own
 *    backend-level processing runs (confirmed live: sre-irs-jwt-auth, shared with
 *    incident-mcp/runbook-mcp on the same HTTPRoute, does exactly this -- the doc's
 *    own reference architecture never combines Entra OBO with a separate JWT-auth
 *    policy on the same route at all, relying solely on the STS's own
 *    subjectValidator). repo-mcp needs its own dedicated HTTPRoute, not covered by
 *    sre-irs-jwt-auth's targetRefs, for its Authorization header to survive intact.
 *
 * Configuration:
 * {
 *   policyName: string,          // Required
 *   namespace: string,           // Required -- must be the SAME namespace the target
 *                                 // Backend lives in (Backend-kind targetRefs require it)
 *   staticBackendName: string,   // Required -- exact EnterpriseAgentgatewayBackend name
 *                                 // this policy targets (e.g. 'repo-mcp-backend')
 *   tenantId: string,            // Required -- Entra tenant id (GUID; a domain name or
 *                                 // 'common' is rejected)
 *   clientId: string,            // Required -- must match the incoming user token's
 *                                 // audience (this repo's convention: reuse agent-gateway's
 *                                 // own Entra app registration)
 *   clientSecretEnvVar: string,  // Required -- env var name holding the real external
 *                                 // Entra client secret (never a committed literal)
 *   scope: string,               // Required -- single Graph-style scope string, e.g.
 *                                 // 'api://<repo-mcp-client-id>/.default'
 * }
 */
export class EntraOboPolicyFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.policyName = config.policyName;
    this.staticBackendName = config.staticBackendName;
    this.tenantId = config.tenantId;
    this.clientId = config.clientId;
    this.clientSecretEnvVar = config.clientSecretEnvVar || null;
    this.clientSecret = this.clientSecretEnvVar ? process.env[this.clientSecretEnvVar] : undefined;
    this.clientSecretName = `${config.policyName}-entra-obo-client`;
    this.clientSecretKey = 'clientSecret';
    this.scope = config.scope;
  }

  validate() {
    if (!this.policyName) throw new Error('entra-obo-policy: policyName is required');
    if (!this.namespace) throw new Error('entra-obo-policy: namespace is required');
    if (!this.staticBackendName) throw new Error('entra-obo-policy: staticBackendName is required');
    if (!this.tenantId) throw new Error('entra-obo-policy: tenantId is required');
    if (!this.clientId) throw new Error('entra-obo-policy: clientId is required');
    if (!this.clientSecret) {
      throw new Error(
        this.clientSecretEnvVar
          ? `entra-obo-policy: environment variable ${this.clientSecretEnvVar} is not set`
          : 'entra-obo-policy: clientSecretEnvVar is required'
      );
    }
    if (!this.scope) throw new Error('entra-obo-policy: scope is required');
    return true;
  }

  buildClientSecret() {
    return {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: this.clientSecretName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentic-demo',
          'agentic.demo/feature': this.name,
        },
      },
      type: 'Opaque',
      stringData: { [this.clientSecretKey]: this.clientSecret },
    };
  }

  buildOboPolicy() {
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
          {
            group: 'enterpriseagentgateway.solo.io',
            kind: 'EnterpriseAgentgatewayBackend',
            name: this.staticBackendName,
          },
        ],
        backend: {
          tokenExchange: {
            mode: 'ExchangeOnly',
            entra: {
              tenantId: this.tenantId,
              clientId: this.clientId,
              scope: this.scope,
              clientSecretRef: { name: this.clientSecretName, key: this.clientSecretKey },
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
      await this.applyResource(this.buildClientSecret(), context);
      await this.applyResource(this.buildOboPolicy(), context);
      this.log(
        `Entra OBO policy '${this.policyName}' applied, targeting live Backend '${this.staticBackendName}'`,
        'success'
      );
    }
  }

  async cleanup() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.deleteResource('enterpriseagentgatewaypolicy', this.policyName, this.namespace, context);
      await this.deleteResource('secret', this.clientSecretName, this.namespace, context);
    }
    this.log(`Entra OBO policy '${this.policyName}' removed`, 'success');
  }
}
