import path from 'path';
import { fileURLToPath } from 'url';
import { unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { AddonFeature } from '../../src/lib/feature.js';
import { KubernetesHelper, CommandRunner } from '../../src/lib/common.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(__dirname, 'config');

const OSS_VERSION = '0.7.7';
const ENTERPRISE_VERSION = '0.4.4';

const OSS_REGISTRY = 'oci://ghcr.io/kagent-dev/kagent/helm';
const ENTERPRISE_REGISTRY = 'oci://us-docker.pkg.dev/solo-public/kagent-enterprise-helm/charts';

const CRDS_RELEASE = 'kagent-crds';
const CONTROLLER_RELEASE = 'kagent';

/**
 * KagentFeature
 *
 * Installs kagent (OSS) or Solo Enterprise for kagent - Kubernetes-native AI agent platform.
 *
 * Enterprise installs two charts: kagent-enterprise-crds (CRDs) + kagent-enterprise (controller).
 * UI comes from the solo-ui addon; enable the kagent tab via products.kagent.enabled=true.
 *
 * Configuration:
 * {
 *   enterprise: boolean,         // Default: false (OSS)
 *   namespace: string,           // Default: 'kagent-system'
 *   version: string,             // Chart version. Default: OSS_VERSION or ENTERPRISE_VERSION
 *   kubeContext: string,         // Optional: kube context for multi-cluster
 *   oidc: {
 *     issuer: string,            // Explicit OIDC issuer URL (overrides computed value)
 *     keycloakHostname: string,  // Keycloak hostname — issuer computed from this
 *     keycloakTlsEnabled: bool,  // Whether Keycloak uses HTTPS (default: false)
 *     realm: string,             // Keycloak realm (default: 'kagent')
 *     clientId: string,          // OIDC client ID (default: 'kagent-backend' enterprise / 'kagent' OSS)
 *     clientSecret: string,      // OIDC client secret
 *     // OSS only:
 *     cookieSecret: string,      // oauth2-proxy cookie secret (auto-generated if unset)
 *     redirectUrl: string,       // oauth2-proxy callback URL
 *   },
 *   rbac: {
 *     adminsGroup: string,       // Default: 'kagent-admins'
 *     writersGroup: string,      // Default: 'kagent-writers'
 *     readersGroup: string,      // Default: 'kagent-readers'
 *   },
 *   provider: {
 *     type: string,              // LLM provider type (default: 'openAI')
 *     model: string,             // Optional: model override
 *   },
 *   otel: {
 *     endpoint: string,          // OTLP gRPC endpoint for tracing
 *   },
 *   database: {
 *     bundled: boolean,          // Use bundled postgres (default: true)
 *     url: string,               // External postgres URL (when bundled: false)
 *     storageClass: string,      // Storage class for bundled postgres PVC
 *   },
 *   registerClusters: string[],  // Register clusters in the shared UI via platform.solo.io/v1alpha1
 *                                // KubernetesCluster CRs (applied against kubeContext). List this
 *                                // cluster plus relay-connected workload clusters (e.g. ['east','west'])
 *                                // so they show as registered, not just tunneled. Requires solo-ui's
 *                                // management-crds on this cluster. Default: [].
 *   ambient: boolean,            // Label namespace istio.io/dataplane-mode=ambient. Needed for
 *                                // kagent-controller to be reachable cross-cluster via
 *                                // *.mesh.internal (e.g. remote AgentRegistry registering it as a
 *                                // Runtime); outside the mesh that suffix is NXDOMAIN. Default: false.
 *   globalServices: string[],    // Services here to label solo.io/service-scope=global (e.g.
 *                                // ['kagent-controller']) for *.mesh.internal reach from other
 *                                // clusters. Applied post-install; only meaningful with ambient.
 *                                // Default: [].
 *   waypointTrustDomain: {
 *     skipValidate: boolean,     // Default: false -- sets SKIP_VALIDATE_TRUST_DOMAIN=true on
 *                                // every kagent-created waypoint on this cluster. Enterprise
 *                                // only. kagent gives no per-agent hook for this (each Agent's
 *                                // waypoint Gateway carries no infrastructure.parametersRef of
 *                                // its own -- confirmed in kagent-enterprise's
 *                                // translateWaypointGateway()), so this is necessarily
 *                                // cluster-wide: applied via an EnterpriseAgentgatewayParameters
 *                                // object referenced from the shared
 *                                // enterprise-agentgateway-waypoint GatewayClass's own
 *                                // parametersRef. Needed for multi-cluster A2A: a waypoint's
 *                                // own TrustDomainVerifier only trusts its own cluster's trust
 *                                // domain by default and rejects any cross-cluster caller's
 *                                // mTLS identity even though the underlying cert chain
 *                                // validates fine -- confirmed live and against
 *                                // agentgateway-enterprise's own source
 *                                // (crates/agentgateway/src/transport/tls.rs). Unrelated to,
 *                                // and not fixable via, istiod's PILOT_SKIP_VALIDATE_TRUST_DOMAIN
 *                                // -- agentgateway-enterprise doesn't consume istiod's xDS at
 *                                // all for this check, it has its own separate control plane.
 *   },
 * }
 *
 * Environment variables:
 *   ENTERPRISE_KAGENT_LICENSE  — required for enterprise mode
 *   OPENAI_API_KEY      — required when provider.type is 'openAI'
 *   ANTHROPIC_API_KEY   — required when provider.type is 'anthropic'
 */
export class KagentFeature extends AddonFeature {
  constructor(name, config = {}) {
    super(name, config);
    this.enterprise = config.enterprise === true;
    this.namespace = config.namespace || 'kagent-system';
    this.version = config.version || (this.enterprise ? ENTERPRISE_VERSION : OSS_VERSION);
    this.kubeContext = config.kubeContext || null;

    this.crdsOci = this.enterprise
      ? `${ENTERPRISE_REGISTRY}/kagent-enterprise-crds`
      : `${OSS_REGISTRY}/kagent-crds`;
    this.controllerOci = this.enterprise
      ? `${ENTERPRISE_REGISTRY}/kagent-enterprise`
      : `${OSS_REGISTRY}/kagent`;

    // OIDC: compute issuer from keycloakHostname if not explicit
    const oidc = config.oidc || {};
    if (oidc.issuer) {
      this.oidcIssuer = oidc.issuer;
    } else if (oidc.keycloakHostname) {
      const scheme = oidc.keycloakTlsEnabled ? 'https' : 'http';
      const realm = oidc.realm || 'kagent';
      this.oidcIssuer = `${scheme}://${oidc.keycloakHostname}/realms/${realm}`;
    } else {
      this.oidcIssuer = null;
    }

    // Unified OIDC client (enterprise uses kagent-backend, OSS uses kagent)
    this.oidcClientId = oidc.clientId || (this.enterprise ? 'kagent-backend' : 'kagent');
    this.oidcClientSecret = oidc.clientSecret || null;

    // OSS-only: oauth2-proxy
    this.oidcCookieSecret = oidc.cookieSecret || null;
    this.oidcRedirectUrl = oidc.redirectUrl || null;

    // RBAC group -> kagent role mappings (enterprise)
    const rbac = config.rbac || {};
    this.rbacAdminsGroup = rbac.adminsGroup || 'kagent-admins';
    this.rbacWritersGroup = rbac.writersGroup || 'kagent-writers';
    this.rbacReadersGroup = rbac.readersGroup || 'kagent-readers';
    this.rbacAgentregistryGroup = rbac.agentregistryGroup || 'agentregistry';

    // LLM provider
    const provider = config.provider || {};
    this.providerType = provider.type || 'openAI';
    this.providerModel = provider.model || null;

    // OTel tracing
    const otel = config.otel || {};
    this.otlpEndpoint = otel.endpoint || null;
    // OTEL_EXPORTER_OTLP_TRACES_ENDPOINT must be a full URL - a bare host:port is misparsed by
    // Go's url.Parse (host read as scheme), leaving an empty target and the runtime error
    // "delegating_resolver: invalid target address \"\": missing address".
    if (this.otlpEndpoint && !/^https?:\/\//.test(this.otlpEndpoint)) {
      this.otlpEndpoint = `http://${this.otlpEndpoint}`;
    }

    // Database
    const database = config.database || {};
    this.databaseBundled = database.bundled !== false;
    this.databaseUrl = database.url || null;
    this.databaseStorageClass = database.storageClass || null;

    // Fleet registration: announces clusters to the shared UI's Connected Clusters list
    this.registerClusters = Array.isArray(config.registerClusters) ? config.registerClusters : [];

    // Cross-cluster mesh visibility
    this.ambient = config.ambient === true;
    this.globalServices = Array.isArray(config.globalServices) ? config.globalServices : [];

    // Waypoint cross-cluster trust domain (enterprise only)
    const waypointTrustDomain = config.waypointTrustDomain || {};
    this.waypointSkipValidateTrustDomain = waypointTrustDomain.skipValidate === true;
    this.waypointTrustDomainParamsName = 'kagent-waypoint-trust-domain-params';
  }

  validate() {
    if (this.enterprise && !process.env.ENTERPRISE_KAGENT_LICENSE) {
      throw new Error(
        'ENTERPRISE_KAGENT_LICENSE environment variable is required for kagent Enterprise'
      );
    }
    return true;
  }

  async deploy() {
    const mode = this.enterprise ? 'Enterprise' : 'OSS';
    this.log(`Installing kagent ${mode} ${this.version}`);
    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];

    await KubernetesHelper.ensureNamespace(this.namespace, this.spinner, this.kubeContext);

    if (this.ambient) {
      await KubernetesHelper.kubectl(
        [
          ...(this.kubeContext ? [`--context=${this.kubeContext}`] : []),
          'label',
          'namespace',
          this.namespace,
          'istio.io/dataplane-mode=ambient',
          '--overwrite',
        ],
        { spinner: this.spinner }
      );
    }

    // 1. CRDs
    this.log('Installing kagent CRDs');
    await KubernetesHelper.helm(
      [
        'upgrade',
        '-i',
        CRDS_RELEASE,
        this.crdsOci,
        '-n',
        this.namespace,
        '--version',
        this.version,
        '--wait',
        ...helmCtxArgs,
      ],
      { spinner: this.spinner }
    );

    if (this.enterprise) {
      await this._deployEnterprise(helmCtxArgs);
    } else {
      await this._deployOSS(helmCtxArgs);
    }

    await this._registerClusters();
    await this._labelGlobalServices();
    await this._applyWaypointTrustDomainConfig();

    this.log(`kagent ${mode} installed successfully.`, 'success');
  }

  /**
   * Cluster-wide override for every kagent-created waypoint's own
   * TrustDomainVerifier (agentgateway-enterprise) -- see waypointTrustDomain's
   * doc comment above for why this can't be scoped narrower than the shared
   * enterprise-agentgateway-waypoint GatewayClass. Requires that GatewayClass
   * to already exist (created by the kagent-enterprise chart install above).
   */
  async _applyWaypointTrustDomainConfig() {
    if (!this.enterprise || !this.waypointSkipValidateTrustDomain) return;

    await this.applyResource(
      {
        apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
        kind: 'EnterpriseAgentgatewayParameters',
        metadata: { name: this.waypointTrustDomainParamsName, namespace: this.namespace },
        spec: {
          env: [{ name: 'SKIP_VALIDATE_TRUST_DOMAIN', value: 'true' }],
        },
      },
      this.kubeContext
    );

    await KubernetesHelper.kubectl(
      [
        ...(this.kubeContext ? [`--context=${this.kubeContext}`] : []),
        'patch',
        'gatewayclass',
        'enterprise-agentgateway-waypoint',
        '--type=merge',
        '-p',
        JSON.stringify({
          spec: {
            parametersRef: {
              group: 'enterpriseagentgateway.solo.io',
              kind: 'EnterpriseAgentgatewayParameters',
              name: this.waypointTrustDomainParamsName,
              namespace: this.namespace,
            },
          },
        }),
      ],
      { spinner: this.spinner }
    );

    this.log(
      "Disabled cross-cluster trust-domain validation on every kagent waypoint (SKIP_VALIDATE_TRUST_DOMAIN=true, via GatewayClass 'enterprise-agentgateway-waypoint')",
      'success'
    );
  }

  /**
   * Label Services for cross-cluster (*.mesh.internal) visibility. Runs post-install -
   * the kagent-controller Service doesn't exist until then.
   */
  async _labelGlobalServices() {
    if (this.globalServices.length === 0) return;

    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    for (const svcName of this.globalServices) {
      this.log(`Labeling service "${svcName}" for global (cross-cluster) visibility`, 'info');
      await KubernetesHelper.kubectl(
        [
          ...ctxArgs,
          'label',
          'service',
          svcName,
          '-n',
          this.namespace,
          'solo.io/service-scope=global',
          '--overwrite',
        ],
        { spinner: this.spinner }
      );
    }
  }

  /**
   * Register clusters with the shared UI's fleet controller so they show in Connected
   * Clusters (not just a tunneled relay). Plain marker (platform.solo.io/v1alpha1
   * KubernetesCluster, spec: {}); doesn't affect telemetry, which flows regardless.
   */
  async _registerClusters() {
    if (this.registerClusters.length === 0) return;

    this.log(
      `Registering clusters with the shared UI: ${this.registerClusters.join(', ')}`,
      'info'
    );
    for (const clusterName of this.registerClusters) {
      await this.applyResource(
        {
          apiVersion: 'platform.solo.io/v1alpha1',
          kind: 'KubernetesCluster',
          metadata: { name: clusterName },
        },
        this.kubeContext
      );
    }
    this.log('Cluster registration complete', 'success');
  }

  async _deployEnterprise(helmCtxArgs) {
    const licenseKey = process.env.ENTERPRISE_KAGENT_LICENSE;

    // 2. Controller
    this.log('Installing kagent controller');
    const controllerArgs = [
      'upgrade',
      '-i',
      CONTROLLER_RELEASE,
      this.controllerOci,
      '-n',
      this.namespace,
      '--version',
      this.version,
      '--wait',
      '--timeout',
      '10m',
      '--values',
      path.join(CONFIG_DIR, 'values.yaml'),
      '--set-string',
      `global.licensing.licenseKey=${licenseKey}`,
      ...helmCtxArgs,
    ];

    if (this.oidcIssuer) {
      controllerArgs.push(
        '--set',
        `oidc.issuer=${this.oidcIssuer}`,
        '--set',
        `oidc.clientId=${this.oidcClientId}`,
        '--set',
        `rbac.roleMapping.roleMappings.${this.rbacAdminsGroup}=global.Admin`,
        '--set',
        `rbac.roleMapping.roleMappings.${this.rbacWritersGroup}=global.Writer`,
        '--set',
        `rbac.roleMapping.roleMappings.${this.rbacReadersGroup}=global.Reader`,
        '--set',
        `rbac.roleMapping.roleMappings.${this.rbacAgentregistryGroup}=global.Writer`
      );
      if (this.oidcClientSecret) {
        controllerArgs.push('--set-string', `oidc.secret=${this.oidcClientSecret}`);
      }
    }

    // Force in-cluster JWKS URL: EKS OIDC discovery returns an external URL
    // (oidc.eks.*.amazonaws.com) whose cert the rest.Config HTTP client doesn't trust.
    controllerArgs.push(
      '--set',
      'kubernetes.jwksUrl=https://kubernetes.default.svc/openid/v1/jwks'
    );

    // Workaround for kagent-enterprise chart bug: oidc.issuer writes OIDC_ISSUER into the
    // kagent-enterprise-config ConfigMap, but the controller only envFrom-mounts
    // kagent-controller - so OIDC vars never reach the pod, leaving it in auto-auth mode
    // (401 on all /api/proxy/cluster/<cluster>/api/* requests). Mounting the enterprise config
    // fixes it. Ref: https://github.com/solo-io/kagent-enterprise/issues/1829
    controllerArgs.push(
      '--set-json',
      'controller.envFrom=[{"configMapRef":{"name":"kagent-enterprise-config"}}]'
    );

    this._appendProviderArgs(controllerArgs);
    this._appendDatabaseArgs(controllerArgs);

    if (this.otlpEndpoint) {
      controllerArgs.push(
        '--set',
        'otel.tracing.enabled=true',
        '--set',
        `otel.tracing.exporter.otlp.endpoint=${this.otlpEndpoint}`,
        '--set',
        'otel.tracing.exporter.otlp.insecure=true'
      );
    }

    await KubernetesHelper.helm(controllerArgs, { spinner: this.spinner });
    await KubernetesHelper.assertHelmDeployed(CONTROLLER_RELEASE, this.namespace, this.kubeContext);

    // 3. OBO signing key secret (controller watches secret/jwt)
    await this._ensureOboSigningKey();
  }

  async _deployOSS(helmCtxArgs) {
    const ossArgs = [
      'upgrade',
      '-i',
      CONTROLLER_RELEASE,
      this.controllerOci,
      '-n',
      this.namespace,
      '--version',
      this.version,
      '--wait',
      '--timeout',
      '10m',
      '--values',
      path.join(CONFIG_DIR, 'values.yaml'),
      ...helmCtxArgs,
    ];

    // OSS: oauth2-proxy sidecar for OIDC
    if (this.oidcIssuer) {
      const cookieSecret = this.oidcCookieSecret || this._randomCookieSecret();
      ossArgs.push(
        '--set',
        'oauth2-proxy.enabled=true',
        '--set',
        'controller.auth.mode=secured',
        '--set',
        `oauth2-proxy.config.clientID=${this.oidcClientId}`,
        '--set-string',
        `oauth2-proxy.config.clientSecret=${this.oidcClientSecret || ''}`,
        '--set-string',
        `oauth2-proxy.config.cookieSecret=${cookieSecret}`,
        '--set',
        'oauth2-proxy.extraEnv[0].name=OIDC_ISSUER_URL',
        '--set',
        `oauth2-proxy.extraEnv[0].value=${this.oidcIssuer}`
      );
      if (this.oidcRedirectUrl) {
        ossArgs.push(
          '--set',
          'oauth2-proxy.extraEnv[1].name=OIDC_REDIRECT_URL',
          '--set',
          `oauth2-proxy.extraEnv[1].value=${this.oidcRedirectUrl}`
        );
      }
    }

    if (this.otlpEndpoint) {
      ossArgs.push(
        '--set',
        'otel.tracing.enabled=true',
        '--set',
        `otel.tracing.exporter.otlp.endpoint=${this.otlpEndpoint}`,
        '--set',
        'otel.tracing.exporter.otlp.insecure=true'
      );
    }

    this._appendProviderArgs(ossArgs);
    this._appendDatabaseArgs(ossArgs);

    await KubernetesHelper.helm(ossArgs, { spinner: this.spinner });
    await KubernetesHelper.assertHelmDeployed(CONTROLLER_RELEASE, this.namespace, this.kubeContext);
  }

  _appendProviderArgs(args) {
    const providerApiKey =
      this.providerType === 'openAI'
        ? process.env.OPENAI_API_KEY
        : this.providerType === 'anthropic'
          ? process.env.ANTHROPIC_API_KEY
          : null;

    if (providerApiKey) {
      args.push(
        '--set',
        `providers.default=${this.providerType}`,
        '--set-string',
        `providers.${this.providerType}.apiKey=${providerApiKey}`
      );
    }

    if (this.providerModel) {
      args.push('--set', `providers.${this.providerType}.model=${this.providerModel}`);
    }
  }

  _appendDatabaseArgs(args) {
    if (!this.databaseBundled && this.databaseUrl) {
      args.push(
        '--set',
        'database.postgres.bundled.enabled=false',
        '--set-string',
        `database.postgres.url=${this.databaseUrl}`
      );
    } else if (this.databaseStorageClass) {
      args.push('--set', `database.postgres.bundled.storageClassName=${this.databaseStorageClass}`);
    }
  }

  /**
   * RSA signing key secret the controller uses to mint OBO tokens. Idempotent: skips if
   * present to avoid rotating a live key. Docs:
   * https://docs.solo.io/kagent-enterprise/docs/main/security/obo#signing-key
   */
  async _ensureOboSigningKey() {
    const ctxFlag = this.kubeContext ? `--context=${this.kubeContext}` : '';
    const ctxStr = ctxFlag ? `${ctxFlag} ` : '';

    const check = await CommandRunner.exec(
      `kubectl ${ctxStr}get secret jwt -n ${this.namespace} --ignore-not-found`,
      { ignoreError: true }
    );
    if (!check.exitCode && check.stdout?.trim()) {
      this.log('OBO signing key secret already exists — skipping', 'info');
      return;
    }

    this.log('Creating OBO signing key secret for kagent controller');
    const keyFile = path.join(tmpdir(), `kagent-jwt-key-${Date.now()}.pem`);
    try {
      const genResult = await CommandRunner.exec(
        `openssl genpkey -algorithm RSA -out "${keyFile}" -pkeyopt rsa_keygen_bits:2048`,
        { ignoreError: true }
      );
      if (genResult.exitCode) {
        throw new Error(`openssl genpkey failed: ${genResult.stderr?.trim()}`);
      }

      const createResult = await CommandRunner.exec(
        `kubectl ${ctxStr}create secret generic jwt -n ${this.namespace} --from-file=jwt="${keyFile}" --dry-run=client -o yaml | kubectl ${ctxStr}apply -f -`,
        { ignoreError: true }
      );
      if (createResult.exitCode) {
        throw new Error(`Failed to create OBO jwt secret: ${createResult.stderr?.trim()}`);
      }
      this.log('OBO signing key secret created', 'success');
    } finally {
      try {
        await unlink(keyFile);
      } catch {
        /* ignore */
      }
    }
  }

  async cleanup() {
    this.log('Removing kagent');
    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];
    const kubectlCtxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];

    if (this.enterprise && this.waypointSkipValidateTrustDomain) {
      // Unset rather than leave dangling: harmless if the GatewayClass itself gets removed
      // by the chart uninstall below, but avoids a stale parametersRef pointing at a
      // now-deleted object if it doesn't.
      await KubernetesHelper.kubectl(
        [
          ...kubectlCtxArgs,
          'patch',
          'gatewayclass',
          'enterprise-agentgateway-waypoint',
          '--type=merge',
          '-p',
          '{"spec":{"parametersRef":null}}',
        ],
        { spinner: this.spinner, ignoreError: true }
      );
      await this.deleteResource(
        'EnterpriseAgentgatewayParameters',
        this.waypointTrustDomainParamsName,
        this.namespace,
        this.kubeContext
      ).catch(() => {});
    }

    for (const clusterName of this.registerClusters) {
      await this.deleteResource('KubernetesCluster', clusterName, this.namespace, this.kubeContext);
    }

    // Remove OBO signing key secret
    if (this.enterprise) {
      await this.deleteResource('Secret', 'jwt', this.namespace, this.kubeContext).catch(() => {});
    }

    for (const release of [CONTROLLER_RELEASE, CRDS_RELEASE]) {
      try {
        await KubernetesHelper.helm(['uninstall', release, '-n', this.namespace, ...helmCtxArgs], {
          spinner: this.spinner,
        });
      } catch (err) {
        if (!/not found|no deployed releases/i.test(err.message)) throw err;
      }
    }

    await KubernetesHelper.kubectl([
      ...kubectlCtxArgs,
      'delete',
      'namespace',
      this.namespace,
      '--ignore-not-found=true',
    ]);
    this.log('kagent removed', 'success');
  }

  _randomCookieSecret() {
    // oauth2-proxy requires exactly 16, 24, or 32 bytes base64-encoded
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Buffer.from(bytes).toString('base64').slice(0, 32);
  }
}
