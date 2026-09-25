import { Feature } from '../../../src/lib/feature.js';

/**
 * StagePolicyControllerFeature
 *
 * Deploys retail-returns-agent-system's stage-policy-controller: a small
 * internal service (not customer-facing -- only reachable from the guided
 * tour's own BFF over cluster-internal networking) that applies/removes a
 * fixed, named set of EnterpriseAgentgatewayPolicy resources on demand, so
 * the guided tour can be "clickops" (a presenter's "Apply policy" / "Remove
 * policy" button controls whether a stage's backend policy actually exists,
 * rather than every stage's policy being pre-provisioned before the tour
 * ever starts).
 *
 * This feature deploys the service itself (ServiceAccount/Deployment/
 * Service in this.namespace) plus the RBAC granting it write access -- and
 * ONLY write access -- to the specific, already-known policy object names it
 * manages (managedPolicyNames), in backendDiscoveryNamespace. RBAC is
 * provisioned once, by the trusted CLI operator, same as every other
 * feature in this repo; only the policy objects themselves toggle on
 * demand, not the permission to do so. Kubernetes RBAC can't scope the
 * `create` verb by resourceNames (the object doesn't exist yet at admission
 * time), so `create` is granted repo-type-wide while get/list/watch/update/
 * patch/delete are pinned to managedPolicyNames via a second rule -- the
 * tightest split the mechanism allows.
 *
 * Configuration:
 * {
 *   namespace: string,                 // Default: 'retail-returns' -- service's own namespace
 *   backendDiscoveryNamespace: string, // Default: 'agentregistry-system' -- where the policy objects live
 *   serverName: string,                // Default: 'stage-policy-controller'
 *   image: string,                     // Required -- container image
 *   imagePullPolicy: string,           // Default: 'IfNotPresent'
 *   port: number,                      // Default: 8080
 *   managedPolicyNames: string[],      // Required, non-empty -- EnterpriseAgentgatewayPolicy names this service may create/mutate
 *   readOnlyRefs: [{                   // Optional -- other stages' already-provisioned policy
 *     resource: string,                // objects this service may only ever read (get/list/watch),
 *     name: string,                    // for showing "spec: down" in the UI. Never create/mutate/
 *     namespace: string,               // delete these, regardless of resource type or namespace --
 *     apiGroup: string,                // Default: 'enterpriseagentgateway.solo.io'
 *   }],                                // e.g. {resource: 'enterpriseagentgatewaybudgets', name: '...', namespace: 'agentgateway-proxy'}
 *   accessPolicyNamespace: string,      // Default: 'kagent-system' -- where managedAccessPolicyNames live
 *   managedAccessPolicyNames: string[], // Optional -- kagent AccessPolicy (policy.kagent-enterprise.solo.io)
 *                                       // names this service may create/mutate, same clickops pattern as
 *                                       // managedPolicyNames but a different CRD/API group entirely, so a
 *                                       // separate Role/RoleBinding (can't combine apiGroups in one rule
 *                                       // with different resourceNames semantics cleanly)
 *   env: object,                       // Optional -- extra container env vars (name: value), merged in
 *                                       // after PORT. E.g. stage definitions needing environment-specific
 *                                       // values (a Keycloak issuer URL, a demo username) read them from
 *                                       // here rather than the image hardcoding them.
 * }
 */
export class StagePolicyControllerFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.namespace = config.namespace || 'retail-returns';
    this.backendDiscoveryNamespace = config.backendDiscoveryNamespace || 'agentregistry-system';
    this.serverName = config.serverName || 'stage-policy-controller';
    this.image = config.image;
    this.imagePullPolicy = config.imagePullPolicy || 'IfNotPresent';
    this.port = config.port || 8080;
    this.managedPolicyNames = config.managedPolicyNames || [];
    this.readOnlyRefs = config.readOnlyRefs || [];
    this.accessPolicyNamespace = config.accessPolicyNamespace || 'kagent-system';
    this.managedAccessPolicyNames = config.managedAccessPolicyNames || [];
    this.env = config.env || {};
  }

  validate() {
    if (!this.image) throw new Error('stage-policy-controller: image is required');
    if (this.managedPolicyNames.length === 0)
      throw new Error('stage-policy-controller: managedPolicyNames is required (non-empty)');
    return true;
  }

  labels() {
    return {
      'app.kubernetes.io/managed-by': 'agentic-demo',
      'agentic.demo/feature': this.name,
    };
  }

  async deployServer(context) {
    await this.applyResource(
      {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: { name: this.serverName, namespace: this.namespace, labels: this.labels() },
      },
      context
    );

    await this.applyResource(
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
          name: this.serverName,
          namespace: this.namespace,
          labels: { ...this.labels(), app: this.serverName },
        },
        spec: {
          selector: { app: this.serverName },
          ports: [{ port: this.port, targetPort: this.port }],
        },
      },
      context
    );

    await this.applyResource(
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
          name: this.serverName,
          namespace: this.namespace,
          labels: { ...this.labels(), app: this.serverName },
        },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: this.serverName } },
          template: {
            metadata: { labels: { app: this.serverName } },
            spec: {
              serviceAccountName: this.serverName,
              containers: [
                {
                  name: 'server',
                  image: this.image,
                  imagePullPolicy: this.imagePullPolicy,
                  ports: [{ containerPort: this.port }],
                  env: [
                    { name: 'PORT', value: String(this.port) },
                    ...Object.entries(this.env).map(([name, value]) => ({ name, value })),
                  ],
                  resources: {
                    requests: { memory: '64Mi', cpu: '50m' },
                    limits: { memory: '128Mi', cpu: '200m' },
                  },
                  readinessProbe: {
                    tcpSocket: { port: this.port },
                    initialDelaySeconds: 3,
                    periodSeconds: 10,
                  },
                  livenessProbe: {
                    tcpSocket: { port: this.port },
                    initialDelaySeconds: 5,
                    periodSeconds: 30,
                  },
                },
              ],
            },
          },
        },
      },
      context
    );

    this.log(`stage-policy-controller server '${this.serverName}' deployed`, 'info');
  }

  /** Groups readOnlyRefs by namespace, then by (apiGroup, resource) -- a Role's
   * rules are per-namespace, and each rule's resourceNames only makes sense
   * per resource type within a single API group. */
  groupReadOnlyRefs() {
    const byNamespace = new Map();
    for (const ref of this.readOnlyRefs) {
      const apiGroup = ref.apiGroup || 'enterpriseagentgateway.solo.io';
      if (!byNamespace.has(ref.namespace)) byNamespace.set(ref.namespace, new Map());
      const byResource = byNamespace.get(ref.namespace);
      const key = `${apiGroup}/${ref.resource}`;
      if (!byResource.has(key))
        byResource.set(key, { apiGroup, resource: ref.resource, names: [] });
      byResource.get(key).names.push(ref.name);
    }
    return byNamespace;
  }

  readOnlyRules(byResource) {
    return [...byResource.values()].map(({ apiGroup, resource, names }) => ({
      apiGroups: [apiGroup],
      resources: [resource],
      resourceNames: names,
      verbs: ['get', 'list', 'watch'],
    }));
  }

  async applyRoleAndBinding(roleName, namespace, rules, context) {
    await this.applyResource(
      {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'Role',
        metadata: { name: roleName, namespace, labels: this.labels() },
        rules,
      },
      context
    );
    await this.applyResource(
      {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'RoleBinding',
        metadata: { name: roleName, namespace, labels: this.labels() },
        subjects: [{ kind: 'ServiceAccount', name: this.serverName, namespace: this.namespace }],
        roleRef: { kind: 'Role', name: roleName, apiGroup: 'rbac.authorization.k8s.io' },
      },
      context
    );
  }

  async deployRbac(context) {
    const managerRoleName = `${this.serverName}-policy-manager`;
    const readerRoleName = `${this.serverName}-policy-reader`;

    const readOnlyByNamespace = this.groupReadOnlyRefs();
    // Read-only refs that land in the same namespace as the managed
    // policies fold into that one Role, instead of a redundant second Role
    // in the same namespace.
    const readOnlyInManagerNamespace = readOnlyByNamespace.get(this.backendDiscoveryNamespace);
    readOnlyByNamespace.delete(this.backendDiscoveryNamespace);

    const managerRules = [
      // create can't be scoped by resourceNames (the object doesn't exist
      // yet at admission time) -- granted repo-type-wide, deliberately
      // separate from the pinned rule below.
      {
        apiGroups: ['enterpriseagentgateway.solo.io'],
        resources: ['enterpriseagentgatewaypolicies'],
        verbs: ['create'],
      },
      // Every other verb is pinned to exactly the named objects this
      // service is allowed to manage -- it cannot mutate or delete any
      // other policy in this namespace.
      {
        apiGroups: ['enterpriseagentgateway.solo.io'],
        resources: ['enterpriseagentgatewaypolicies'],
        resourceNames: this.managedPolicyNames,
        verbs: ['get', 'list', 'watch', 'update', 'patch', 'delete'],
      },
      // Read-only, for live Backend-name discovery (agentregistry's
      // per-server Backend names are hash-suffixed and not knowable
      // ahead of time -- same constraint the JS mcp-tool-policy feature
      // has, see its own discoverBackendName doc comment).
      {
        apiGroups: ['enterpriseagentgateway.solo.io'],
        resources: ['enterpriseagentgatewaybackends'],
        verbs: ['get', 'list'],
      },
      ...(readOnlyInManagerNamespace ? this.readOnlyRules(readOnlyInManagerNamespace) : []),
    ];
    await this.applyRoleAndBinding(
      managerRoleName,
      this.backendDiscoveryNamespace,
      managerRules,
      context
    );

    // Separate, read-only-only Role(s) for any other namespace a readOnlyRef
    // lands in -- this service can never create/mutate/delete anything there.
    for (const [namespace, byResource] of readOnlyByNamespace) {
      await this.applyRoleAndBinding(
        readerRoleName,
        namespace,
        this.readOnlyRules(byResource),
        context
      );
    }

    this.log(
      `RBAC applied: '${this.serverName}' (namespace '${this.namespace}') may manage ` +
        `[${this.managedPolicyNames.join(', ')}] in '${this.backendDiscoveryNamespace}'` +
        (this.readOnlyRefs.length > 0
          ? `, and read-only [${this.readOnlyRefs.map(r => r.name).join(', ')}]`
          : ''),
      'success'
    );
  }

  async deployAccessPolicyRbac(context) {
    if (this.managedAccessPolicyNames.length === 0) return;
    const roleName = `${this.serverName}-access-policy-manager`;
    const rules = [
      // create can't be scoped by resourceNames (the object doesn't exist yet
      // at admission time) -- granted repo-type-wide, deliberately separate
      // from the pinned rule below. Same split deployRbac() uses for
      // EnterpriseAgentgatewayPolicy, just a different CRD/API group.
      {
        apiGroups: ['policy.kagent-enterprise.solo.io'],
        resources: ['accesspolicies'],
        verbs: ['create'],
      },
      {
        apiGroups: ['policy.kagent-enterprise.solo.io'],
        resources: ['accesspolicies'],
        resourceNames: this.managedAccessPolicyNames,
        verbs: ['get', 'list', 'watch', 'update', 'patch', 'delete'],
      },
    ];
    await this.applyRoleAndBinding(roleName, this.accessPolicyNamespace, rules, context);
    this.log(
      `RBAC applied: '${this.serverName}' may manage AccessPolicy [${this.managedAccessPolicyNames.join(', ')}] in '${this.accessPolicyNamespace}'`,
      'success'
    );
  }

  async deploy() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    for (const context of contextsToDeploy) {
      await this.deployServer(context);
      await this.deployRbac(context);
      await this.deployAccessPolicyRbac(context);
    }
  }

  async cleanup() {
    const contextsToDeploy =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];
    const managerRoleName = `${this.serverName}-policy-manager`;
    const readerRoleName = `${this.serverName}-policy-reader`;
    const accessPolicyRoleName = `${this.serverName}-access-policy-manager`;
    const readOnlyNamespaces = [...this.groupReadOnlyRefs().keys()].filter(
      ns => ns !== this.backendDiscoveryNamespace
    );
    for (const context of contextsToDeploy) {
      await this.deleteResource(
        'RoleBinding',
        managerRoleName,
        this.backendDiscoveryNamespace,
        context
      );
      await this.deleteResource('Role', managerRoleName, this.backendDiscoveryNamespace, context);
      for (const namespace of readOnlyNamespaces) {
        await this.deleteResource('RoleBinding', readerRoleName, namespace, context);
        await this.deleteResource('Role', readerRoleName, namespace, context);
      }
      if (this.managedAccessPolicyNames.length > 0) {
        await this.deleteResource(
          'RoleBinding',
          accessPolicyRoleName,
          this.accessPolicyNamespace,
          context
        );
        await this.deleteResource(
          'Role',
          accessPolicyRoleName,
          this.accessPolicyNamespace,
          context
        );
      }
      await this.deleteResource('Deployment', this.serverName, this.namespace, context);
      await this.deleteResource('Service', this.serverName, this.namespace, context);
      await this.deleteResource('ServiceAccount', this.serverName, this.namespace, context);
    }
    this.log('stage-policy-controller feature cleaned up', 'success');
  }
}
