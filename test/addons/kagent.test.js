import { test, expect, beforeEach, afterEach } from 'bun:test';
import { KagentFeature } from '../../addons/kagent/index.js';

let savedLicense;
let savedAgentgatewayLicense;

beforeEach(() => {
  savedLicense = process.env.ENTERPRISE_KAGENT_LICENSE;
  delete process.env.ENTERPRISE_KAGENT_LICENSE;
  savedAgentgatewayLicense = process.env.ENTERPRISE_AGENTGATEWAY_LICENSE;
  delete process.env.ENTERPRISE_AGENTGATEWAY_LICENSE;
});

afterEach(() => {
  if (savedLicense !== undefined) process.env.ENTERPRISE_KAGENT_LICENSE = savedLicense;
  else delete process.env.ENTERPRISE_KAGENT_LICENSE;
  if (savedAgentgatewayLicense !== undefined) {
    process.env.ENTERPRISE_AGENTGATEWAY_LICENSE = savedAgentgatewayLicense;
  } else {
    delete process.env.ENTERPRISE_AGENTGATEWAY_LICENSE;
  }
});

// ── Baseline characterization (pre-substrate behavior) ──────────────────────

test('KagentFeature constructor defaults (OSS)', () => {
  const f = new KagentFeature('kagent', {});
  expect(f.enterprise).toBe(false);
  expect(f.namespace).toBe('kagent-system');
  expect(f.version).toBe('0.7.7');
  expect(f.kubeContext).toBeNull();
  expect(f.crdsOci).toContain('ghcr.io/kagent-dev/kagent/helm/kagent-crds');
  expect(f.controllerOci).toContain('ghcr.io/kagent-dev/kagent/helm/kagent');
});

test('KagentFeature constructor defaults (enterprise)', () => {
  const f = new KagentFeature('kagent', { enterprise: true });
  expect(f.enterprise).toBe(true);
  expect(f.version).toBe('2026.11.2');
  expect(f.crdsOci).toContain('kagent-enterprise-crds');
  expect(f.controllerOci).toContain('kagent-enterprise');
});

test('KagentFeature constructor respects version override', () => {
  const f = new KagentFeature('kagent', { enterprise: true, version: '0.5.8' });
  expect(f.version).toBe('0.5.8');
});

test('KagentFeature OIDC issuer computed from keycloakHostname', () => {
  const f = new KagentFeature('kagent', {
    enterprise: true,
    oidc: { keycloakHostname: 'keycloak.example.com', keycloakTlsEnabled: true, realm: 'kagent' },
  });
  expect(f.oidcIssuer).toBe('https://keycloak.example.com/realms/kagent');
  // Default enterprise version is now the CalVer/alpha-chart line, so the alpha chart's own
  // clientId convention applies (see 'oidcClientId defaults differ by chart line' below).
  expect(f.oidcClientId).toBe('kagent-enterprise');
});

test('KagentFeature OIDC issuer explicit override wins', () => {
  const f = new KagentFeature('kagent', {
    enterprise: true,
    oidc: {
      issuer: 'https://explicit.example.com/realms/x',
      keycloakHostname: 'ignored.example.com',
    },
  });
  expect(f.oidcIssuer).toBe('https://explicit.example.com/realms/x');
});

test('KagentFeature captureSensitiveContent defaults off', () => {
  const f = new KagentFeature('kagent', { otel: { endpoint: 'collector:4317' } });
  expect(f.captureSensitiveContent).toBe(false);
});

test('KagentFeature captureSensitiveContent respects explicit true', () => {
  const f = new KagentFeature('kagent', {
    otel: { endpoint: 'collector:4317', captureSensitiveContent: true },
  });
  expect(f.captureSensitiveContent).toBe(true);
});

test('KagentFeature evaluations defaults to disabled', () => {
  const f = new KagentFeature('kagent', { enterprise: true });
  expect(f.evaluations.enabled).toBe(false);
  expect(f.evaluations.judge.defaultModelConfig).toBeNull();
  expect(f.evaluations.judge.namespace).toBeNull();
  expect(f.evaluations.judge.secretNames).toEqual([]);
});

test('KagentFeature evaluations config parses overrides', () => {
  const f = new KagentFeature('kagent', {
    enterprise: true,
    evaluations: {
      enabled: true,
      judge: {
        defaultModelConfig: 'default-model-config',
        namespace: 'kagent-system',
        secretNames: ['kagent-openai'],
      },
    },
  });
  expect(f.evaluations.enabled).toBe(true);
  expect(f.evaluations.judge.defaultModelConfig).toBe('default-model-config');
  expect(f.evaluations.judge.namespace).toBe('kagent-system');
  expect(f.evaluations.judge.secretNames).toEqual(['kagent-openai']);
});

test('KagentFeature rbac group defaults', () => {
  const f = new KagentFeature('kagent', { enterprise: true });
  expect(f.rbacAdminsGroup).toBe('kagent-admins');
  expect(f.rbacWritersGroup).toBe('kagent-writers');
  expect(f.rbacReadersGroup).toBe('kagent-readers');
});

test('KagentFeature validate throws when enterprise without license', () => {
  const f = new KagentFeature('kagent', { enterprise: true });
  expect(() => f.validate()).toThrow('ENTERPRISE_KAGENT_LICENSE');
});

test('KagentFeature validate passes for OSS without license', () => {
  const f = new KagentFeature('kagent', {});
  expect(f.validate()).toBe(true);
});

test('KagentFeature validate passes for enterprise with license', () => {
  process.env.ENTERPRISE_KAGENT_LICENSE = 'test-license';
  const f = new KagentFeature('kagent', { enterprise: true });
  expect(f.validate()).toBe(true);
});

// ── Agent Substrate config parsing ───────────────────────────────────────────

test('substrate defaults to disabled', () => {
  const f = new KagentFeature('kagent', { enterprise: true });
  expect(f.substrate.enabled).toBe(false);
});

test('substrate config parses with defaults', () => {
  const f = new KagentFeature('kagent', {
    enterprise: true,
    substrate: { enabled: true, workerPool: { workerImage: 'ghcr.io/x/ateom-gvisor:v0' } },
  });
  expect(f.substrate.enabled).toBe(true);
  expect(f.substrate.version).toBe('1.1.0-alpha1-7354c972');
  expect(f.substrate.registry).toBe(
    'oci://us-docker.pkg.dev/solo-public/enterprise-substrate-helm'
  );
  expect(f.substrate.namespace).toBe('ate-system');
  expect(f.substrate.kubectlAteVersion).toBe('v1.1.0-alpha1');
  expect(f.substrate.workerPool.name).toBe('kagent-default');
  expect(f.substrate.workerPool.replicas).toBe(1);
  expect(f.substrate.workerPool.workerImage).toBe('ghcr.io/x/ateom-gvisor:v0');
  expect(f.substrate.workerPool.sandboxClass).toBe('gvisor');
  expect(f.substrate.snapshots.backend).toBe('s3');
  expect(f.substrate.snapshots.identityAnnotationKey).toBeNull();
  expect(f.substrate.snapshots.identityAnnotationValue).toBeNull();
});

test('substrate config parses with overrides', () => {
  const f = new KagentFeature('kagent', {
    enterprise: true,
    substrate: {
      enabled: true,
      version: '0.2.0-beta8',
      registry: 'oci://example.com/custom-substrate-helm',
      namespace: 'custom-ate',
      kubectlAteVersion: 'v0.2.0-beta8',
      workerPool: {
        name: 'custom-pool',
        replicas: 3,
        workerImage: 'ghcr.io/x/ateom-gvisor:v1',
        sandboxClass: 'gvisor',
      },
      snapshots: {
        identityAnnotation: {
          key: 'iam.gke.io/gcp-service-account',
          value: 'substrate-snapshots@my-project.iam.gserviceaccount.com',
        },
      },
    },
  });
  expect(f.substrate.version).toBe('0.2.0-beta8');
  expect(f.substrate.registry).toBe('oci://example.com/custom-substrate-helm');
  expect(f.substrate.namespace).toBe('custom-ate');
  expect(f.substrate.kubectlAteVersion).toBe('v0.2.0-beta8');
  expect(f.substrate.workerPool.name).toBe('custom-pool');
  expect(f.substrate.workerPool.replicas).toBe(3);
  expect(f.substrate.snapshots.backend).toBe('gcs');
  expect(f.substrate.snapshots.identityAnnotationKey).toBe('iam.gke.io/gcp-service-account');
  expect(f.substrate.snapshots.identityAnnotationValue).toBe(
    'substrate-snapshots@my-project.iam.gserviceaccount.com'
  );
});

test('substrate snapshots backend derives s3 for an IRSA annotation key', () => {
  const f = new KagentFeature('kagent', {
    enterprise: true,
    substrate: {
      enabled: true,
      workerPool: { workerImage: 'ghcr.io/x/ateom-gvisor:v0' },
      snapshots: {
        identityAnnotation: {
          key: 'eks.amazonaws.com/role-arn',
          value: 'arn:aws:iam::123456789012:role/substrate-snapshots-role',
        },
      },
    },
  });
  expect(f.substrate.snapshots.backend).toBe('s3');
});

test('substrate workerPool.workerImage defaults to the chart version, no config required', () => {
  const f = new KagentFeature('kagent', { enterprise: true, substrate: { enabled: true } });
  expect(f.substrate.workerPool.workerImage).toBe(
    'us-docker.pkg.dev/solo-public/substrate-enterprise/ateworker-gvisor:v1.1.0-alpha1-7354c972'
  );
});

test('substrate workerPool.workerImage derives from an explicit substrate.version', () => {
  const f = new KagentFeature('kagent', {
    enterprise: true,
    substrate: { enabled: true, version: '0.2.0-beta8' },
  });
  expect(f.substrate.workerPool.workerImage).toBe(
    'us-docker.pkg.dev/solo-public/substrate-enterprise/ateworker-gvisor:v0.2.0-beta8'
  );
});

// ── Substrate validate() ─────────────────────────────────────────────────────

test('validate throws when substrate enabled without ENTERPRISE_AGENTGATEWAY_LICENSE', () => {
  process.env.ENTERPRISE_KAGENT_LICENSE = 'test-license';
  const f = new KagentFeature('kagent', { enterprise: true, substrate: { enabled: true } });
  expect(() => f.validate()).toThrow('ENTERPRISE_AGENTGATEWAY_LICENSE');
});

test('validate passes for substrate enabled with no workerImage config (auto-derived)', () => {
  process.env.ENTERPRISE_KAGENT_LICENSE = 'test-license';
  process.env.ENTERPRISE_AGENTGATEWAY_LICENSE = 'test-agentgateway-license';
  const f = new KagentFeature('kagent', { enterprise: true, substrate: { enabled: true } });
  expect(f.validate()).toBe(true);
});

test('validate passes for substrate enabled with no identityAnnotation (bundled default)', () => {
  process.env.ENTERPRISE_KAGENT_LICENSE = 'test-license';
  process.env.ENTERPRISE_AGENTGATEWAY_LICENSE = 'test-agentgateway-license';
  const f = new KagentFeature('kagent', {
    enterprise: true,
    substrate: { enabled: true, workerPool: { workerImage: 'ghcr.io/x/ateom-gvisor:v0' } },
  });
  expect(f.validate()).toBe(true);
});

test('validate throws when identityAnnotation.key is set without a value', () => {
  process.env.ENTERPRISE_KAGENT_LICENSE = 'test-license';
  process.env.ENTERPRISE_AGENTGATEWAY_LICENSE = 'test-agentgateway-license';
  const f = new KagentFeature('kagent', {
    enterprise: true,
    substrate: {
      enabled: true,
      workerPool: { workerImage: 'ghcr.io/x/ateom-gvisor:v0' },
      snapshots: { identityAnnotation: { key: 'iam.gke.io/gcp-service-account' } },
    },
  });
  expect(() => f.validate()).toThrow('identityAnnotation.value');
});

// ── Evaluations validate() ───────────────────────────────────────────────────

test('validate throws when evaluations enabled without judge.defaultModelConfig', () => {
  process.env.ENTERPRISE_KAGENT_LICENSE = 'test-license';
  const f = new KagentFeature('kagent', {
    enterprise: true,
    evaluations: { enabled: true, judge: { secretNames: ['kagent-openai'] } },
  });
  expect(() => f.validate()).toThrow('evaluations.judge.defaultModelConfig');
});

test('validate throws when evaluations enabled without judge.secretNames', () => {
  process.env.ENTERPRISE_KAGENT_LICENSE = 'test-license';
  const f = new KagentFeature('kagent', {
    enterprise: true,
    evaluations: { enabled: true, judge: { defaultModelConfig: 'default-model-config' } },
  });
  expect(() => f.validate()).toThrow('evaluations.judge.secretNames');
});

test('validate passes for evaluations enabled with judge config set', () => {
  process.env.ENTERPRISE_KAGENT_LICENSE = 'test-license';
  const f = new KagentFeature('kagent', {
    enterprise: true,
    evaluations: {
      enabled: true,
      judge: { defaultModelConfig: 'default-model-config', secretNames: ['kagent-openai'] },
    },
  });
  expect(f.validate()).toBe(true);
});

test('validate passes for substrate enabled with a full identityAnnotation', () => {
  process.env.ENTERPRISE_KAGENT_LICENSE = 'test-license';
  process.env.ENTERPRISE_AGENTGATEWAY_LICENSE = 'test-agentgateway-license';
  const f = new KagentFeature('kagent', {
    enterprise: true,
    substrate: {
      enabled: true,
      workerPool: { workerImage: 'ghcr.io/x/ateom-gvisor:v0' },
      snapshots: {
        identityAnnotation: {
          key: 'iam.gke.io/gcp-service-account',
          value: 'substrate-snapshots@my-project.iam.gserviceaccount.com',
        },
      },
    },
  });
  expect(f.validate()).toBe(true);
});

// ── Substrate pure builders ──────────────────────────────────────────────────

test('_kubectlAteDownloadUrl builds a URL for the current platform', () => {
  const f = new KagentFeature('kagent', { enterprise: true });
  const url = f._kubectlAteDownloadUrl();
  expect(url).toStartWith(
    'https://github.com/kagent-dev/substrate/releases/download/v1.1.0-alpha1/kubectl-ate-'
  );
  expect(url).toMatch(/kubectl-ate-(darwin|linux)-(amd64|arm64)$/);
});

test('_kubectlAteDownloadUrl honors kubectlAteVersion override', () => {
  const f = new KagentFeature('kagent', {
    enterprise: true,
    substrate: { kubectlAteVersion: 'v0.2.0-beta8' },
  });
  expect(f._kubectlAteDownloadUrl()).toContain('/download/v0.2.0-beta8/kubectl-ate-');
});

test('_kubectlAteChecksumUrl appends .sha256 to the binary download URL', () => {
  const f = new KagentFeature('kagent', { enterprise: true });
  expect(f._kubectlAteChecksumUrl()).toBe(`${f._kubectlAteDownloadUrl()}.sha256`);
});

test('_parseSha256Checksum parses a sha256sum-style line matching the asset name', () => {
  const f = new KagentFeature('kagent', { enterprise: true });
  const content =
    'aa94b04dfb29a649094eafeae754300587abb6ab1fbda529cebe149b78177d0c  kubectl-ate-darwin-amd64\n';
  expect(f._parseSha256Checksum(content, 'kubectl-ate-darwin-amd64')).toBe(
    'aa94b04dfb29a649094eafeae754300587abb6ab1fbda529cebe149b78177d0c'
  );
});

test('_parseSha256Checksum parses bare hex content with no filename suffix', () => {
  const f = new KagentFeature('kagent', { enterprise: true });
  const content = '0869A8A441AD2FEF3E7AD9BE9222FF7FBDC38D8C820C948B2B81337854B1AB67\n';
  expect(f._parseSha256Checksum(content, 'kubectl-ate-darwin-arm64')).toBe(
    '0869a8a441ad2fef3e7ad9be9222ff7fbdc38d8c820c948b2b81337854b1ab67'
  );
});

test('_parseSha256Checksum skips lines for a different asset and matches the right one', () => {
  const f = new KagentFeature('kagent', { enterprise: true });
  const content = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  kubectl-ate-linux-amd64',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  kubectl-ate-darwin-arm64',
  ].join('\n');
  expect(f._parseSha256Checksum(content, 'kubectl-ate-darwin-arm64')).toBe(
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  );
});

test('_parseSha256Checksum returns null for empty or malformed content', () => {
  const f = new KagentFeature('kagent', { enterprise: true });
  expect(f._parseSha256Checksum('', 'kubectl-ate-darwin-arm64')).toBeNull();
  expect(f._parseSha256Checksum('not a checksum', 'kubectl-ate-darwin-arm64')).toBeNull();
});

test('_buildSubstrateControllerArgs returns empty array when disabled', () => {
  const f = new KagentFeature('kagent', { enterprise: true });
  expect(f._buildSubstrateControllerArgs()).toEqual([]);
});

test('_buildSubstrateControllerArgs builds expected flags when enabled', () => {
  const f = new KagentFeature('kagent', {
    namespace: 'kagent',
    enterprise: true,
    substrate: { enabled: true, workerPool: { workerImage: 'ghcr.io/x/ateom-gvisor:v0' } },
  });
  const args = f._buildSubstrateControllerArgs();
  expect(args).toContain('substrate.enabled=false');
  expect(args).toContain('controller.substrate.enabled=true');
  expect(args).toContain('controller.substrate.ateApiEndpoint=dns:///api.ate-system.svc:443');
  expect(args).toContain(
    'controller.substrate.atenetRouterURL=http://atenet-router.ate-system.svc:80'
  );
  expect(args).toContain('substrateWorkerPool.create=true');
  expect(args).toContain('substrateWorkerPool.name=kagent-default');
  expect(args).toContain('substrateWorkerPool.replicas=1');
  expect(args).toContain('substrateWorkerPool.workerImage=ghcr.io/x/ateom-gvisor:v0');
  expect(args).toContain('substrateWorkerPool.sandboxClass=gvisor');
});

test('_buildSubstrateControllerArgs respects a custom substrate namespace', () => {
  const f = new KagentFeature('kagent', {
    enterprise: true,
    substrate: {
      enabled: true,
      namespace: 'custom-ate',
      workerPool: { workerImage: 'x' },
    },
  });
  const args = f._buildSubstrateControllerArgs();
  expect(args).toContain('controller.substrate.ateApiEndpoint=dns:///api.custom-ate.svc:443');
  expect(args).toContain(
    'controller.substrate.atenetRouterURL=http://atenet-router.custom-ate.svc:80'
  );
});

// ── Alpha chart OIDC + UI exposure ───────────────────────────────────────────

test('isAlphaChart is false for OSS and old enterprise chart versions', () => {
  expect(new KagentFeature('kagent', {}).isAlphaChart).toBe(false);
  expect(new KagentFeature('kagent', { enterprise: true, version: '0.5.8' }).isAlphaChart).toBe(
    false
  );
});

test('isAlphaChart is true for 1.x enterprise versions', () => {
  const f = new KagentFeature('kagent', { enterprise: true, version: '1.0.0-alpha3' });
  expect(f.isAlphaChart).toBe(true);
});

test('isAlphaChart is true for CalVer enterprise versions (chart switched schemes at 2026.11.0)', () => {
  expect(new KagentFeature('kagent', { enterprise: true, version: '2026.11.2' }).isAlphaChart).toBe(
    true
  );
  expect(new KagentFeature('kagent', { enterprise: true, version: '2026.11.0' }).isAlphaChart).toBe(
    true
  );
});

test('oidcClientId defaults differ by chart line', () => {
  expect(new KagentFeature('kagent', {}).oidcClientId).toBe('kagent');
  expect(new KagentFeature('kagent', { enterprise: true, version: '0.5.8' }).oidcClientId).toBe(
    'kagent-backend'
  );
  expect(
    new KagentFeature('kagent', { enterprise: true, version: '1.0.0-alpha3' }).oidcClientId
  ).toBe('kagent-enterprise');
});

test('oidcUiClientId defaults to kagent-ui and is overridable', () => {
  const f = new KagentFeature('kagent', { enterprise: true, version: '1.0.0-alpha3' });
  expect(f.oidcUiClientId).toBe('kagent-ui');
  const overridden = new KagentFeature('kagent', {
    enterprise: true,
    version: '1.0.0-alpha3',
    oidc: { uiClientId: 'custom-ui' },
  });
  expect(overridden.oidcUiClientId).toBe('custom-ui');
});

test('hostname/tls/gatewayClassName defaults', () => {
  const f = new KagentFeature('kagent', { enterprise: true, version: '1.0.0-alpha3' });
  expect(f.hostname).toBeNull();
  expect(f.tlsSecretName).toBe('kagent-ui-tls');
  expect(f.tlsIssuer).toBe('letsencrypt-dns');
  expect(f.gatewayClassName).toBe('enterprise-agentgateway');
  expect(f.gatewaySourceRanges).toBeNull();
});

test('_ensureUiGateway applies no parametersRef when gatewaySourceRanges is unset', async () => {
  const f = new KagentFeature('kagent', {
    namespace: 'kagent',
    enterprise: true,
    version: '1.0.0-alpha3',
    hostname: 'kagent-ui.example.com',
  });
  const applied = [];
  f.applyResource = async resource => applied.push(resource);
  await f._ensureUiGateway();

  const gateway = applied.find(r => r.kind === 'Gateway');
  expect(gateway.spec.infrastructure).toBeUndefined();
  expect(applied.find(r => r.kind === 'EnterpriseAgentgatewayParameters')).toBeUndefined();
});

test('_ensureUiGateway restricts the LB to gatewaySourceRanges when set', async () => {
  const f = new KagentFeature('kagent', {
    namespace: 'kagent',
    enterprise: true,
    version: '1.0.0-alpha3',
    hostname: 'kagent-ui.example.com',
    gatewaySourceRanges: ['165.99.148.61/32', '64.226.138.86/32'],
  });
  const applied = [];
  f.applyResource = async resource => applied.push(resource);
  await f._ensureUiGateway();

  const params = applied.find(r => r.kind === 'EnterpriseAgentgatewayParameters');
  expect(params.apiVersion).toBe('enterpriseagentgateway.solo.io/v1alpha1');
  expect(params.metadata).toEqual({ name: 'kagent-ui-https-params', namespace: 'kagent' });
  expect(params.spec.service.spec.loadBalancerSourceRanges).toEqual([
    '165.99.148.61/32',
    '64.226.138.86/32',
  ]);

  const gateway = applied.find(r => r.kind === 'Gateway');
  expect(gateway.spec.infrastructure.parametersRef).toEqual({
    name: 'kagent-ui-https-params',
    group: 'enterpriseagentgateway.solo.io',
    kind: 'EnterpriseAgentgatewayParameters',
  });
  // params applied before the Gateway that references it
  expect(applied.indexOf(params)).toBeLessThan(applied.indexOf(gateway));
});

test('_appendUiHttpRouteArgs is a no-op when not alpha chart or no hostname', () => {
  const args1 = [];
  new KagentFeature('kagent', {
    enterprise: true,
    version: '0.5.8',
    hostname: 'x.example.com',
  })._appendUiHttpRouteArgs(args1);
  expect(args1).toEqual([]);

  const args2 = [];
  new KagentFeature('kagent', { enterprise: true, version: '1.0.0-alpha3' })._appendUiHttpRouteArgs(
    args2
  );
  expect(args2).toEqual([]);
});

test('_appendUiHttpRouteArgs builds expected flags for the alpha chart with a hostname', () => {
  const f = new KagentFeature('kagent', {
    namespace: 'kagent',
    enterprise: true,
    version: '1.0.0-alpha3',
    hostname: 'kagent-ui.example.com',
  });
  const args = [];
  f._appendUiHttpRouteArgs(args);
  expect(args).toContain('ui.httpRoute.enabled=true');
  const parentRefsArg = args.find(a => a.startsWith('ui.httpRoute.parentRefs='));
  expect(parentRefsArg).toBeDefined();
  expect(JSON.parse(parentRefsArg.replace('ui.httpRoute.parentRefs=', ''))).toEqual([
    {
      group: 'gateway.networking.k8s.io',
      kind: 'Gateway',
      name: 'kagent-ui-https',
      namespace: 'kagent',
    },
  ]);
  const hostnamesArg = args.find(a => a.startsWith('ui.httpRoute.hostnames='));
  expect(JSON.parse(hostnamesArg.replace('ui.httpRoute.hostnames=', ''))).toEqual([
    'kagent-ui.example.com',
  ]);
});

// ── Evaluations (agentevals) controller args ─────────────────────────────────

test('_appendEvaluationsArgs is a no-op when not alpha chart or not enabled', () => {
  const args1 = [];
  new KagentFeature('kagent', {
    enterprise: true,
    version: '0.5.8',
    evaluations: {
      enabled: true,
      judge: { defaultModelConfig: 'default-model-config', secretNames: ['kagent-openai'] },
    },
  })._appendEvaluationsArgs(args1);
  expect(args1).toEqual([]);

  const args2 = [];
  new KagentFeature('kagent', {
    enterprise: true,
    version: '1.0.0-alpha3',
  })._appendEvaluationsArgs(args2);
  expect(args2).toEqual([]);
});

test('_appendEvaluationsArgs builds expected flags for the alpha chart when enabled', () => {
  const f = new KagentFeature('kagent', {
    enterprise: true,
    version: '1.0.0-alpha3',
    evaluations: {
      enabled: true,
      judge: { defaultModelConfig: 'default-model-config', secretNames: ['kagent-openai'] },
    },
  });
  const args = [];
  f._appendEvaluationsArgs(args);
  expect(args).toContain('agentevals.enabled=true');
  expect(args).toContain('agentevals.judge.defaultModelConfig=default-model-config');
  const secretNamesArg = args.find(a => a.startsWith('agentevals.judge.secretNames='));
  expect(JSON.parse(secretNamesArg.replace('agentevals.judge.secretNames=', ''))).toEqual([
    'kagent-openai',
  ]);
  expect(args.some(a => a.startsWith('agentevals.judge.namespace='))).toBe(false);
});

test('_appendEvaluationsArgs includes judge.namespace when set', () => {
  const f = new KagentFeature('kagent', {
    enterprise: true,
    version: '1.0.0-alpha3',
    evaluations: {
      enabled: true,
      judge: {
        defaultModelConfig: 'default-model-config',
        namespace: 'kagent-system',
        secretNames: ['kagent-openai'],
      },
    },
  });
  const args = [];
  f._appendEvaluationsArgs(args);
  expect(args).toContain('agentevals.judge.namespace=kagent-system');
});

// ── Generated credentials (RustFS / ClickHouse) ──────────────────────────────

test('_randomCredential generates a URL/shell-safe string with no padding', () => {
  const f = new KagentFeature('kagent', { enterprise: true });
  const value = f._randomCredential();
  expect(value.length).toBeGreaterThan(0);
  expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
});

test('_randomCredential never repeats across calls', () => {
  const f = new KagentFeature('kagent', { enterprise: true });
  expect(f._randomCredential()).not.toBe(f._randomCredential());
});

test('_decodeSecretPair decodes a "b64|b64" jsonpath result', () => {
  const f = new KagentFeature('kagent', { enterprise: true });
  const encoded = `${Buffer.from('rustfsadmin').toString('base64')}|${Buffer.from('s3cr3t').toString('base64')}`;
  expect(f._decodeSecretPair(encoded)).toEqual(['rustfsadmin', 's3cr3t']);
});

test('_decodeSecretPair returns null for empty or malformed content', () => {
  const f = new KagentFeature('kagent', { enterprise: true });
  expect(f._decodeSecretPair('')).toBeNull();
  expect(f._decodeSecretPair('no-pipe-here')).toBeNull();
});
