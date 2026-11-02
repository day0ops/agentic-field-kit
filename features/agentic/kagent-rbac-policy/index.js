import { Feature } from '../../../src/lib/feature.js';

// EnterpriseKagentRBACPolicy leaf resource keys that support both view and manage access
// levels (docs.solo.io/kagent/1.0.x/security/policies/) -- same catalog as the kagent
// addon's own _applyRbacPolicies, duplicated here since a usecase-scoped policy has no
// reason to import addon internals for one constant.
const RBAC_CATALOG_RESOURCES = [
  'agents',
  'agent-templates',
  'harnesses',
  'model-configs',
  'runtimes',
];

// Resources outside the addon's own catalog list but still real EnterpriseKagentRBACPolicy
// grant targets. 'sessions' governs Session/SendMessage access specifically -- confirmed
// live, 2026-11-01: a group with only agents/harnesses/etc. grants (even 'manage') still
// gets SendMessage rejected with a bare "permission denied" once any policy exists on the
// cluster, because Session is a distinct resource key the catalog grants never cover.
// 'sessions-all-creators' is a separate, read-only-capable resource key for seeing every
// user's sessions, not just the caller's own -- for an oversight role (e.g. operators),
// not for a regular end-user group.
const OTHER_RBAC_RESOURCES = ['sessions', 'sessions-all-creators', 'traces'];

/**
 * KagentRbacPolicyFeature
 *
 * Applies an EnterpriseKagentRBACPolicy CR (kagent-enterprise.solo.io/v1alpha1) scoping
 * catalog access (Agent/AgentTemplate/Harness/ModelConfig/Runtime/Traces) to a Keycloak
 * group, for a usecase whose own end users need access beyond the kagent addon's own
 * cluster-wide admins/writers/readers baseline (addons/kagent/index.js's
 * _applyRbacPolicies). Kept usecase-scoped rather than folded into that addon's rbac
 * config, matching how token-exchange-policy/substrate-a2a-route are feature-level, not
 * addon-level: this policy's groups and grants are specific to one usecase's own users,
 * not cluster infrastructure.
 *
 * As soon as any EnterpriseKagentRBACPolicy exists on a cluster, every group without a
 * matching grant is denied catalog access entirely (confirmed live, 2026-10-31, by the
 * kagent addon's own _applyRbacPolicies comment) -- a usecase introducing a new Keycloak
 * group of its own end users needs its own policy for that group to work at all.
 *
 * Configuration:
 * {
 *   policyName: string,  // Required
 *   namespace: string,   // Default: 'kagent-system'
 *   groups: string[],    // Required -- Keycloak group names, matched against the
 *                         // `groups` principal attribute (the token claim named by
 *                         // enterprise.rbac.groupsClaim, default "Groups")
 *   grants: [{           // Required, at least one
 *     resource: string,    // One of RBAC_CATALOG_RESOURCES, or '*' for every catalog
 *                           // resource
 *     accessLevel: string, // 'view' | 'manage'
 *   }],
 * }
 */
export class KagentRbacPolicyFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.policyName = config.policyName;
    this.groups = config.groups || [];
    this.grants = config.grants || [];
  }

  validate() {
    if (!this.policyName) throw new Error('kagent-rbac-policy: policyName is required');
    if (this.groups.length === 0)
      throw new Error('kagent-rbac-policy: groups is required (non-empty)');
    if (this.grants.length === 0)
      throw new Error('kagent-rbac-policy: grants is required (non-empty)');
    for (const g of this.grants) {
      if (
        g.resource !== '*' &&
        !RBAC_CATALOG_RESOURCES.includes(g.resource) &&
        !OTHER_RBAC_RESOURCES.includes(g.resource)
      ) {
        throw new Error(
          `kagent-rbac-policy: grant resource '${g.resource}' must be one of ${[...RBAC_CATALOG_RESOURCES, ...OTHER_RBAC_RESOURCES].join(', ')}, or '*'`
        );
      }
      if (!['view', 'manage'].includes(g.accessLevel)) {
        throw new Error(
          `kagent-rbac-policy: grant accessLevel must be 'view' or 'manage', got '${g.accessLevel}'`
        );
      }
    }
    return true;
  }

  buildPolicy() {
    return {
      apiVersion: 'kagent-enterprise.solo.io/v1alpha1',
      kind: 'EnterpriseKagentRBACPolicy',
      metadata: {
        name: this.policyName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentic-demo',
          'agentic.demo/feature': this.name,
        },
      },
      spec: {
        principals: [{ all: [{ attribute: 'groups', values: this.groups }] }],
        grants: this.grants.map(g => ({
          name: `${g.accessLevel}-${g.resource}`,
          resource: `kagent:${g.resource}`,
          accessLevel: g.accessLevel,
        })),
      },
    };
  }

  async deploy() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.applyResource(this.buildPolicy(), context);
    }
    this.log(
      `EnterpriseKagentRBACPolicy '${this.policyName}' applied, granting ${this.groups.join(', ')} ${this.grants.map(g => `${g.accessLevel} on ${g.resource}`).join(', ')}`,
      'success'
    );
  }

  async cleanup() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.deleteResource(
        'enterprisekagentrbacpolicy',
        this.policyName,
        this.namespace,
        context
      );
    }
    this.log(`kagent-rbac-policy '${this.policyName}' cleaned up`, 'success');
  }
}
