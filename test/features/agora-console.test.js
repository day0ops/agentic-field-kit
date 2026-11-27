import { describe, it, expect } from 'bun:test';
import { AgoraConsoleFeature } from '../../features/agentic/agora-console/index.js';

describe('agora-console', () => {
  const f = new AgoraConsoleFeature('agora-console', {
    namespace: 'agora-demo',
    catalogApiImage: 'example.com/agora-demo/catalog-api:v0.1.0',
    consoleImage: 'example.com/agora-demo/console:v0.1.0',
    hostname: 'agora.example.com',
  });

  it('builds a catalog-api Deployment with no public exposure', () => {
    const d = f.buildCatalogApiDeployment();
    expect(d.kind).toBe('Deployment');
    expect(d.metadata.name).toBe('catalog-api');
    expect(d.metadata.namespace).toBe('agora-demo');
    expect(d.spec.template.spec.containers[0].image).toBe(
      'example.com/agora-demo/catalog-api:v0.1.0'
    );
    expect(d.spec.template.spec.containers[0].ports[0].containerPort).toBe(18080);
  });

  it('builds a catalog-api Service, ClusterIP only', () => {
    const s = f.buildCatalogApiService();
    expect(s.kind).toBe('Service');
    expect(s.metadata.name).toBe('catalog-api');
    expect(s.spec.ports[0].port).toBe(18080);
    expect(s.spec.type).toBeUndefined();
  });

  it('builds a console Deployment with CATALOG_API_URL pointed at the in-cluster catalog-api Service', () => {
    const d = f.buildConsoleDeployment();
    expect(d.kind).toBe('Deployment');
    expect(d.metadata.name).toBe('console');
    expect(d.spec.template.spec.containers[0].image).toBe('example.com/agora-demo/console:v0.1.0');
    const env = d.spec.template.spec.containers[0].env;
    expect(env).toContainEqual({ name: 'PORT', value: '18090' });
    expect(env).toContainEqual({
      name: 'CATALOG_API_URL',
      value: 'http://catalog-api.agora-demo.svc.cluster.local:18080',
    });
  });

  it('builds a console Service on the console port', () => {
    const s = f.buildConsoleService();
    expect(s.metadata.name).toBe('console');
    expect(s.spec.ports[0].port).toBe(18090);
  });

  it('builds a Certificate for the public hostname', () => {
    const c = f.buildCertificate();
    expect(c.kind).toBe('Certificate');
    expect(c.spec.dnsNames).toEqual(['agora.example.com']);
    expect(c.spec.issuerRef.name).toBe('letsencrypt-dns');
  });

  it('builds a Gateway with no infrastructure.parametersRef when sourceRanges is not set', () => {
    const g = f.buildGateway();
    expect(g.kind).toBe('Gateway');
    expect(g.spec.gatewayClassName).toBe('enterprise-agentgateway');
    expect(g.spec.listeners[0].hostname).toBe('agora.example.com');
    expect(g.spec.infrastructure).toBeUndefined();
  });

  it('builds no GatewayParameters when sourceRanges is not set', () => {
    expect(f.buildGatewayParameters()).toBeUndefined();
  });

  it('builds an HTTPRoute with a public rule and a gated /account rule, both pointing at the console Service', () => {
    const r = f.buildHTTPRoute();
    expect(r.kind).toBe('HTTPRoute');
    expect(r.spec.hostnames).toEqual(['agora.example.com']);
    expect(r.spec.rules).toEqual([
      {
        name: 'public',
        matches: [{ path: { type: 'PathPrefix', value: '/' } }],
        backendRefs: [{ group: '', kind: 'Service', name: 'console', port: 18090 }],
      },
      {
        name: 'gated',
        matches: [{ path: { type: 'PathPrefix', value: '/account' } }],
        backendRefs: [{ group: '', kind: 'Service', name: 'console', port: 18090 }],
      },
    ]);
  });

  it('validate throws when a required field is missing', () => {
    const bad = new AgoraConsoleFeature('agora-console', {
      namespace: 'agora-demo',
      catalogApiImage: 'example.com/catalog-api:v1',
    });
    expect(() => bad.validate()).toThrow('consoleImage');
  });

  it('builds a ServiceAccount, Role, and RoleBinding for the console namespace', () => {
    const sa = f.buildServiceAccount();
    expect(sa.kind).toBe('ServiceAccount');
    expect(sa.metadata.name).toBe('agora-console');
    expect(sa.metadata.namespace).toBe('agora-demo');

    const role = f.buildRole();
    expect(role.kind).toBe('Role');
    expect(role.metadata.namespace).toBe('agora-demo');

    const rb = f.buildRoleBinding();
    expect(rb.kind).toBe('RoleBinding');
    expect(rb.subjects).toEqual([
      { kind: 'ServiceAccount', name: 'agora-console', namespace: 'agora-demo' },
    ]);
  });

  it('grants ate-client TokenRequest RBAC cross-namespace into ateNamespace (default ate-system)', () => {
    const role = f.buildAteTokenRole();
    expect(role.metadata.namespace).toBe('ate-system');
    expect(role.rules).toEqual([
      {
        apiGroups: [''],
        resources: ['serviceaccounts/token'],
        resourceNames: ['ate-client'],
        verbs: ['create'],
      },
    ]);

    const rb = f.buildAteTokenRoleBinding();
    expect(rb.metadata.namespace).toBe('ate-system');
    expect(rb.subjects).toEqual([
      { kind: 'ServiceAccount', name: 'agora-console', namespace: 'agora-demo' },
    ]);
  });
});

// ateApiEndpoint's presence is the opt-in trigger for the whole substrate-
// status capability (RBAC objects, serviceAccountName, ATE_* env) - the same
// "optional, presence-triggers-wiring" convention this feature already uses
// for agentGatewayBaseUrl. Usecases that never set it (e.g. the stale
// agora-demo.yaml variant) get zero new resources and zero behavior change.
describe('agora-console with ateApiEndpoint configured', () => {
  const f = new AgoraConsoleFeature('agora-console', {
    namespace: 'agora-demo',
    catalogApiImage: 'example.com/catalog-api:v1',
    consoleImage: 'example.com/console:v1',
    hostname: 'agora.example.com',
    ateApiEndpoint: 'api.ate-system.svc.cluster.local:443',
  });

  it('builds the console Deployment with serviceAccountName set and ATE_* env wired, defaulting workerPoolName and AGORA_ATESPACE from agentNamespace (kagent-system), never this.namespace', () => {
    const d = f.buildConsoleDeployment();
    expect(d.spec.template.spec.serviceAccountName).toBe('agora-console');
    const env = d.spec.template.spec.containers[0].env;
    expect(env).toContainEqual({
      name: 'ATE_API_ENDPOINT',
      value: 'api.ate-system.svc.cluster.local:443',
    });
    // AGORA_ATESPACE, never ATE_NAMESPACE - kubectl-ate itself reads
    // ATE_NAMESPACE from its own process environment as its control-plane
    // target (solo-io/substrate's internal/ateclient/builder.go); reusing
    // that name here would silently redirect kubectl-ate away from the real
    // ate-system control plane (confirmed during the final review of this
    // feature). Defaults to agentNamespace's own default ('kagent-system'),
    // NOT this feature's `namespace` ('agora-demo' in this fixture) - the
    // console's own deployment namespace and the agents' namespace are
    // different concepts that only happen to coincide in agora-demo-local.
    expect(env).toContainEqual({ name: 'AGORA_ATESPACE', value: 'kagent-system' });
    expect(env).not.toContainEqual(expect.objectContaining({ name: 'ATE_NAMESPACE' }));
    expect(env).toContainEqual({ name: 'ATE_WORKER_POOL_NAME', value: 'agora-workers' });
  });

  // Backs the native ate-api gRPC client (console's grpcActorSource) -
  // kubelet-projected, so the console never mints or refreshes a token or CA
  // bundle itself. kubectl-ate stays wired up as the fallback via its own
  // ate-client RBAC grant (buildAteTokenRole/buildAteTokenRoleBinding),
  // untouched by this.
  it('projects an ate-api CA bundle and a scoped ServiceAccount token, mounted into the console container', () => {
    const d = f.buildConsoleDeployment();
    const volumes = d.spec.template.spec.volumes;
    const caVolume = volumes.find(v => v.name === 'ate-ca');
    expect(caVolume.projected.sources[0].clusterTrustBundle).toEqual({
      signerName: 'servicedns.podcert.ate.dev/identity',
      labelSelector: { matchLabels: { 'podcert.ate.dev/canarying': 'live' } },
      path: 'trust-bundle.pem',
      optional: true, // don't block pod startup if no bundle matches
    });
    const tokenVolume = volumes.find(v => v.name === 'ate-token');
    expect(tokenVolume.projected.sources[0].serviceAccountToken).toEqual({
      audience: 'api.ate-system.svc',
      expirationSeconds: 3600,
      path: 'token',
    });
    const mounts = d.spec.template.spec.containers[0].volumeMounts;
    expect(mounts).toContainEqual({ name: 'ate-ca', mountPath: '/var/run/ate/ca', readOnly: true });
    expect(mounts).toContainEqual({
      name: 'ate-token',
      mountPath: '/var/run/ate/token',
      readOnly: true,
    });
  });

  it('wires AGORA_ATESPACE and KAGENT_PROBE_BASE_URL from an explicit agentNamespace config field when set', () => {
    const f2 = new AgoraConsoleFeature('agora-console', {
      namespace: 'agora-demo',
      catalogApiImage: 'example.com/catalog-api:v1',
      consoleImage: 'example.com/console:v1',
      hostname: 'agora.example.com',
      ateApiEndpoint: 'api.ate-system.svc.cluster.local:443',
      systemKeycloak: {
        hostname: 'keycloak.example.com',
        clientId: 'agora-console-system',
        clientSecret: 'secret',
      },
      agentNamespace: 'some-other-namespace',
    });
    const env = f2.buildConsoleDeployment().spec.template.spec.containers[0].env;
    expect(env).toContainEqual({
      name: 'KAGENT_PROBE_BASE_URL',
      value:
        'http://kagent-controller.some-other-namespace.svc.cluster.local:8083/agents/some-other-namespace',
    });
    expect(env).toContainEqual({ name: 'AGORA_ATESPACE', value: 'some-other-namespace' });
  });

  it('deploy() applies the RBAC objects before the Deployment', async () => {
    const applied = [];
    f.applyResource = async resource => applied.push(resource.kind);
    f.log = () => {};
    await f.deploy();
    expect(applied).toEqual([
      'ServiceAccount',
      'Role',
      'RoleBinding',
      'Role',
      'RoleBinding',
      'Deployment',
      'Service',
      'Deployment',
      'Service',
      'Certificate',
      'Gateway',
      'HTTPRoute',
    ]);
  });

  it('cleanup() deletes the RBAC objects', async () => {
    const deleted = [];
    f.deleteResource = async kind => deleted.push(kind);
    f.log = () => {};
    await f.cleanup();
    expect(deleted).toContain('serviceaccount');
    expect(deleted).toContain('role');
    expect(deleted).toContain('rolebinding');
  });
});

describe('agora-console with systemKeycloak configured', () => {
  const f = new AgoraConsoleFeature('agora-console', {
    namespace: 'agora-demo',
    catalogApiImage: 'example.com/catalog-api:v1',
    consoleImage: 'example.com/console:v1',
    hostname: 'agora.example.com',
    systemKeycloak: {
      hostname: 'keycloak.example.com',
      clientId: 'agora-console-system',
      clientSecret: 'secret',
    },
  });

  it('wires the system OIDC token env and defaults kagentControllerBaseUrl from agentNamespace (kagent-system), never this.namespace', () => {
    const env = f.buildConsoleDeployment().spec.template.spec.containers[0].env;
    expect(env).toContainEqual({
      name: 'AGORA_SYSTEM_OIDC_TOKEN_URL',
      value: 'https://keycloak.example.com/realms/kagent/protocol/openid-connect/token',
    });
    expect(env).toContainEqual({
      name: 'AGORA_SYSTEM_OIDC_CLIENT_ID',
      value: 'agora-console-system',
    });
    const secretEnv = env.find(e => e.name === 'AGORA_SYSTEM_OIDC_CLIENT_SECRET');
    expect(secretEnv.value).toBeUndefined();
    expect(secretEnv.valueFrom.secretKeyRef).toEqual({
      name: 'agora-console-system-keycloak',
      key: 'client-secret',
    });
    // Not agora-demo (this fixture's `namespace`) - kagent-controller and the
    // agents it serves live in agentNamespace, a different concept from
    // where the console itself is deployed (final review finding #4).
    expect(env).toContainEqual({
      name: 'KAGENT_PROBE_BASE_URL',
      value: 'http://kagent-controller.kagent-system.svc.cluster.local:8083/agents/kagent-system',
    });
  });

  it('does not require ateApiEndpoint - no serviceAccountName or RBAC objects needed for the probe alone', () => {
    const d = f.buildConsoleDeployment();
    expect(d.spec.template.spec.serviceAccountName).toBeUndefined();
    expect(d.spec.template.spec.volumes).toBeUndefined();
    expect(d.spec.template.spec.containers[0].volumeMounts).toBeUndefined();
  });

  it('builds a Secret holding the systemKeycloak client secret', () => {
    const s = f.buildSystemKeycloakSecret();
    expect(s.kind).toBe('Secret');
    expect(s.metadata.name).toBe('agora-console-system-keycloak');
    expect(s.metadata.namespace).toBe('agora-demo');
    expect(s.stringData).toEqual({ 'client-secret': 'secret' });
  });

  it('deploy() applies the systemKeycloak Secret before the console Deployment', async () => {
    const applied = [];
    f.applyResource = async resource => applied.push(resource.kind);
    f.log = () => {};
    await f.deploy();
    expect(applied.indexOf('Secret')).toBeGreaterThanOrEqual(0);
    expect(applied.indexOf('Secret')).toBeLessThan(applied.lastIndexOf('Deployment'));
  });

  it('cleanup() deletes the systemKeycloak Secret', async () => {
    const deleted = [];
    f.deleteResource = async kind => deleted.push(kind);
    f.log = () => {};
    await f.cleanup();
    expect(deleted).toContain('secret');
  });
});

describe('agora-console omits substrate/probe wiring entirely when unconfigured', () => {
  const f = new AgoraConsoleFeature('agora-console', {
    namespace: 'agora-demo',
    catalogApiImage: 'example.com/catalog-api:v1',
    consoleImage: 'example.com/console:v1',
    hostname: 'agora.example.com',
  });

  it("omits ATE_*/AGORA_SYSTEM_OIDC_*/KAGENT_PROBE_BASE_URL and serviceAccountName (preserves today's stub behavior)", () => {
    const d = f.buildConsoleDeployment();
    expect(d.spec.template.spec.serviceAccountName).toBeUndefined();
    const names = d.spec.template.spec.containers[0].env.map(e => e.name);
    expect(names).not.toContain('ATE_API_ENDPOINT');
    expect(names).not.toContain('AGORA_SYSTEM_OIDC_TOKEN_URL');
    expect(names).not.toContain('KAGENT_PROBE_BASE_URL');
  });

  it('deploy() does not apply any RBAC objects', async () => {
    const applied = [];
    f.applyResource = async resource => applied.push(resource.kind);
    f.log = () => {};
    await f.deploy();
    expect(applied).not.toContain('ServiceAccount');
    expect(applied).not.toContain('Role');
    expect(applied).not.toContain('RoleBinding');
  });
});

describe('agora-console with sourceRanges', () => {
  const f = new AgoraConsoleFeature('agora-console', {
    namespace: 'agora-demo',
    catalogApiImage: 'example.com/catalog-api:v1',
    consoleImage: 'example.com/console:v1',
    hostname: 'agora.example.com',
    sourceRanges: ['10.0.0.0/8'],
  });

  it('builds GatewayParameters restricting the LoadBalancer Service', () => {
    const p = f.buildGatewayParameters();
    expect(p.kind).toBe('EnterpriseAgentgatewayParameters');
    expect(p.spec.service.spec.loadBalancerSourceRanges).toEqual(['10.0.0.0/8']);
  });

  it('references the GatewayParameters from the Gateway', () => {
    const g = f.buildGateway();
    expect(g.spec.infrastructure.parametersRef.name).toBe('agora-console-https-params');
  });
});

describe('agora-console with exposeDirectly: false', () => {
  const f = new AgoraConsoleFeature('agora-console', {
    namespace: 'agora-demo',
    catalogApiImage: 'example.com/agora-demo/catalog-api:v0.1.0',
    consoleImage: 'example.com/agora-demo/console:v0.1.0',
    hostname: 'agora.example.com',
    exposeDirectly: false,
  });

  it('skips building its own Gateway/Certificate/HTTPRoute', async () => {
    const applied = [];
    f.applyResource = async resource => applied.push(resource.kind);
    f.deleteResource = async () => {};
    f.log = () => {};
    await f.deploy();
    expect(applied).toEqual(['Deployment', 'Service', 'Deployment', 'Service']);
    expect(applied).not.toContain('Certificate');
    expect(applied).not.toContain('Gateway');
    expect(applied).not.toContain('HTTPRoute');
  });

  it('skips deleting its own Gateway/Certificate/HTTPRoute on cleanup', async () => {
    const deleted = [];
    f.deleteResource = async kind => deleted.push(kind);
    f.log = () => {};
    await f.cleanup();
    expect(deleted).toEqual(['service', 'deployment', 'service', 'deployment']);
  });
});

// manageEgressPolicies is a third independent opt-in trigger for the base
// ServiceAccount/Role/RoleBinding trio, alongside ateApiEndpoint - set alone
// (no ateApiEndpoint), it should still wire serviceAccountName and the base
// RBAC objects, but not the ate-token-specific Role/RoleBinding. Its own
// egresspolicies grant is a SEPARATE Role/RoleBinding in agentNamespace, not
// a rule folded into the base Role in this.namespace - EgressPolicy
// resolves in the Agent's own namespace, which can differ from where the
// console itself is deployed (agentNamespace is deliberately different from
// namespace in this fixture, to catch exactly that bug class).
describe('agora-console with manageEgressPolicies configured (no ateApiEndpoint)', () => {
  const f = new AgoraConsoleFeature('agora-console', {
    namespace: 'agora-demo',
    agentNamespace: 'kagent-system',
    catalogApiImage: 'example.com/catalog-api:v1',
    consoleImage: 'example.com/console:v1',
    hostname: 'agora.example.com',
    manageEgressPolicies: true,
  });

  it('does not add an egresspolicies rule to the base Role', () => {
    const role = f.buildRole();
    expect(role.metadata.namespace).toBe('agora-demo');
    expect(role.rules).toEqual([
      {
        apiGroups: ['api.kagent.dev'],
        resources: ['agenttemplates', 'harnesses'],
        verbs: ['get', 'list', 'watch'],
      },
      {
        apiGroups: ['ate.dev'],
        resources: ['workerpools'],
        verbs: ['get', 'list', 'watch'],
      },
    ]);
  });

  it('builds a separate egress-policy Role/RoleBinding in agentNamespace, not this.namespace', () => {
    const role = f.buildEgressPolicyRole();
    expect(role.metadata.namespace).toBe('kagent-system');
    expect(role.rules).toEqual([
      {
        apiGroups: ['api.kagent.dev'],
        resources: ['egresspolicies'],
        verbs: ['get', 'create', 'patch', 'delete'],
      },
    ]);
    const rb = f.buildEgressPolicyRoleBinding();
    expect(rb.metadata.namespace).toBe('kagent-system');
    expect(rb.subjects).toEqual([
      { kind: 'ServiceAccount', name: 'agora-console', namespace: 'agora-demo' },
    ]);
  });

  it('sets serviceAccountName on the console Deployment even without ateApiEndpoint', () => {
    const d = f.buildConsoleDeployment();
    expect(d.spec.template.spec.serviceAccountName).toBe('agora-console');
  });

  it('deploy() applies the base ServiceAccount/Role/RoleBinding and the egress-policy Role/RoleBinding, but not the ate-token Role/RoleBinding', async () => {
    const applied = [];
    f.applyResource = async resource => applied.push(resource.kind);
    f.log = () => {};
    await f.deploy();
    expect(applied).toContain('ServiceAccount');
    expect(applied.filter(k => k === 'Role')).toHaveLength(2);
    expect(applied.filter(k => k === 'RoleBinding')).toHaveLength(2);
  });

  it('cleanup() deletes the egresspolicy object itself plus both Role/RoleBinding pairs, but not the ate-token Role/RoleBinding', async () => {
    const deleted = [];
    f.deleteResource = async kind => deleted.push(kind);
    f.log = () => {};
    await f.cleanup();
    expect(deleted).toContain('egresspolicy');
    expect(deleted).toContain('serviceaccount');
    expect(deleted.filter(k => k === 'role')).toHaveLength(2);
    expect(deleted.filter(k => k === 'rolebinding')).toHaveLength(2);
  });
});

describe('agora-console with neither ateApiEndpoint nor manageEgressPolicies', () => {
  it('builds a Role with only the base agenttemplates/harnesses/workerpools rules', () => {
    const f = new AgoraConsoleFeature('agora-console', {
      namespace: 'agora-demo',
      catalogApiImage: 'example.com/catalog-api:v1',
      consoleImage: 'example.com/console:v1',
      hostname: 'agora.example.com',
    });
    expect(f.buildRole().rules).toHaveLength(2);
  });
});
