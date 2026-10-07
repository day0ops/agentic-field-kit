import path from 'path';
import { fileURLToPath } from 'url';
import { unlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import yaml from 'js-yaml';
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

// Agent Substrate (kagent 1.0.0-alpha line). Standalone chart in its own
// namespace, not a subchart on the kagent releases -- substrate.fullname and
// the chart's role.yaml hardcode a release named "substrate" in "ate-system".
// Per docs.solo.io/kagent/1.0.x/setup/installation/, Enterprise installs use Solo's own
// build of the chart (not the public kagent-dev/substrate OSS chart) -- a distinct
// registry from the public one, and it requires its own licensing key. Live-confirmed
// (2026-10-04): 0.3.0-alpha3 is the version kagent-controller 1.0.0-alpha6 actually vendors
// (see solo-io/enterprise-kagent commit 18986b7) and it DOES fix the CreateActorEgressPolicy
// session-start bug on a clean install -- but real A2A message delivery then fails on every
// session with atenet-router logging "upstream call failed: Connect: tunnel failed", reproduced
// even on a session created after restarting every ate-system component. Root cause not yet
// isolated (looks like atenet-router's own tunnel/mTLS client-cert logic, not network/policy --
// raw TLS connectivity to both candidate hops was confirmed healthy). kagent.version moved to
// 1.0.0-alpha5 instead (see the kagent.version comment in config/environments/google-dev.yaml),
// whose own, older architecture generation is natively paired with beta6 -- not a workaround
// pairing like alpha6/beta6 was.
const SUBSTRATE_VERSION = '0.2.0-beta6-5462374';
const SUBSTRATE_REGISTRY = 'oci://us-docker.pkg.dev/solo-public/enterprise-substrate-helm';
// Worker image tag must match the substrate chart version exactly (same release train) --
// see buildWorkerImage(). Distinct registry path from the chart's own (SUBSTRATE_REGISTRY).
const SUBSTRATE_WORKER_IMAGE_REGISTRY = 'us-docker.pkg.dev/solo-public/substrate-enterprise';
const SUBSTRATE_RELEASE = 'substrate';
const SUBSTRATE_NAMESPACE = 'ate-system';
const PODCERT_NAMESPACE = 'podcertificate-controller-system';
// kubectl-ate is a separate CLI tool, downloaded from the public kagent-dev/substrate
// GitHub releases regardless of which chart registry is used -- not tied to SUBSTRATE_VERSION.
const KUBECTL_ATE_VERSION = 'v0.2.0-beta5';

// Maps the Workload Identity / IRSA annotation key the infra provisioner's own terraform
// output supplies (see substrate.snapshots.identityAnnotation) to the atelet chart's
// storageBackend enum. Cloud-agnostic by construction -- this addon never checks "which
// cloud" directly, it just reads whichever annotation key the infra layer handed it.
const ANNOTATION_KEY_TO_STORAGE_BACKEND = {
  'iam.gke.io/gcp-service-account': 'gcs',
  'eks.amazonaws.com/role-arn': 's3',
};

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
 *   clusterName: string,        // Name this install calls its own cluster (alpha chart:
 *                                // global.cluster). Default: 'mgmt-cluster'. Must match the
 *                                // otel-collector addon's own clusterName, or the kagent UI's
 *                                // Traces tab silently shows no rows (client-side cluster filter).
 *   oidc: {
 *     issuer: string,            // Explicit OIDC issuer URL (overrides computed value)
 *     keycloakHostname: string,  // Keycloak hostname — issuer computed from this
 *     keycloakTlsEnabled: bool,  // Whether Keycloak uses HTTPS (default: false)
 *     realm: string,             // Keycloak realm (default: 'kagent')
 *     clientId: string,          // Backend/API OIDC client ID (default: 'kagent-enterprise' on the
 *                                // 1.0.0-alpha chart line, 'kagent-backend' on the old enterprise
 *                                // chart, 'kagent' on OSS)
 *     clientSecret: string,      // OIDC client secret
 *     uiClientId: string,        // Alpha chart only -- the frontend's own public client,
 *                                // distinct from clientId. Default: 'kagent-ui'
 *     // OSS only:
 *     cookieSecret: string,      // oauth2-proxy cookie secret (auto-generated if unset)
 *     redirectUrl: string,       // oauth2-proxy callback URL
 *   },
 *   hostname: string,            // Alpha chart only -- public hostname to expose the UI at over
 *                                // HTTPS via the chart's native ui.httpRoute + a Gateway this addon
 *                                // creates. Omit to skip UI exposure entirely.
 *   tls: {
 *     secretName: string,        // Default: 'kagent-ui-tls'
 *     issuer: string,            // ClusterIssuer name. Default: 'letsencrypt-dns'
 *   },
 *   gatewayClassName: string,    // GatewayClass the UI's Gateway targets. Default: 'enterprise-agentgateway'
 *   gatewaySourceRanges: string[], // Optional -- CIDR allowlist applied to the UI Gateway's
 *                                  // LoadBalancer Service (spec.loadBalancerSourceRanges) via an
 *                                  // EnterpriseAgentgatewayParameters object. Omit to leave the
 *                                  // LoadBalancer open to the internet.
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
 *     endpoint: string,               // OTLP gRPC endpoint for tracing
 *     captureSensitiveContent: bool,  // Capture prompt/response text on chat spans (default: false).
 *                                     // Required for kagent-ui's own tracing page to show anything --
 *                                     // captured content may be sensitive (PII, secrets in prompts).
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
 *   substrate: {                  // Agent Substrate (gVisor actor/worker sandbox runtime).
 *                                 // Requires kagent-enterprise >= 1.0.0-alpha3 and a Kubernetes
 *                                 // cluster serving certificates.k8s.io/v1beta1 with
 *                                 // PodCertificateRequest/ClusterTrustBundle enabled (GKE 1.37+
 *                                 // RAPID channel; EKS cannot enable these on the managed control
 *                                 // plane). Installs a standalone "substrate" Helm release into its
 *                                 // own "ate-system" namespace (fixed by the chart), separate from
 *                                 // the two kagent releases this addon already manages.
 *     enabled: boolean,           // Default: false
 *     version: string,           // Substrate chart version. Default: '0.2.0-beta5'
 *     namespace: string,         // Default: 'ate-system' (effectively fixed by the chart)
 *     kubectlAteVersion: string, // kubectl-ate CLI + release-asset version. Default: 'v0.2.0-beta5'
 *     workerPool: {
 *       name: string,            // Default: 'kagent-default'
 *       replicas: number,        // Default: 1
 *       workerImage: string,     // Optional -- defaults to SUBSTRATE_WORKER_IMAGE_REGISTRY
 *                                // tagged with this substrate.version (ate-controller starts a
 *                                // Worker with the flags of its own version, so the two must
 *                                // match). Only set this to pin a custom build.
 *       sandboxClass: string,    // Default: 'gvisor' -- the only sandbox class substrate
 *                                // currently supports for kagent-generated ActorTemplates
 *     },
 *     snapshots: {
 *       identityAnnotation: {     // Cloud identity bound to the atelet worker's storage, as a
 *                                 // ready-to-apply KSA annotation. Sourced from the infra
 *                                 // provisioner's own terraform output (gke/eks modules in
 *                                 // cloud-provisioner/terraform-cloud-provisioner), normally
 *                                 // templated in as infra.clusters.<name>.storage.* -- never
 *                                 // hand-typed. Omit (or leave unresolved) to stay on the
 *                                 // bundled RustFS default with no external creds.
 *         key: string,            // e.g. 'iam.gke.io/gcp-service-account' or
 *                                  // 'eks.amazonaws.com/role-arn'
 *         value: string,          // e.g. a GSA email or an IRSA role ARN
 *       },
 *                                 // The atelet chart's storageBackend ('s3' bundled default |
 *                                 // 'gcs') is derived from identityAnnotation.key, not
 *                                 // separately configured -- see
 *                                 // ANNOTATION_KEY_TO_STORAGE_BACKEND. The bucket and path stay
 *                                 // per-Harness (substrate-agent feature's own
 *                                 // snapshots.bucket), never configured globally here.
 *     },
 *   },
 * }
 *
 * Environment variables:
 *   ENTERPRISE_KAGENT_LICENSE      - required for enterprise mode
 *   ENTERPRISE_AGENTGATEWAY_LICENSE - required when substrate.enabled is true (licenses
 *                                     atenet-egress/atenet-router, which run
 *                                     agentgateway-enterprise -- a different product from
 *                                     kagent-enterprise, same env var the agentgateway addon
 *                                     itself uses)
 *   OPENAI_API_KEY      - required when provider.type is 'openAI'
 *   ANTHROPIC_API_KEY   - required when provider.type is 'anthropic'
 */
export class KagentFeature extends AddonFeature {
  constructor(name, config = {}) {
    super(name, config);
    this.enterprise = config.enterprise === true;
    this.namespace = config.namespace || 'kagent-system';
    this.version = config.version || (this.enterprise ? ENTERPRISE_VERSION : OSS_VERSION);
    this.kubeContext = config.kubeContext || null;
    // Name this installation calls its own cluster (alpha chart: global.cluster).
    // Stamped into LOCAL_CLUSTER_NAME/EXTENSION_LOCAL_CLUSTER_NAME for the controller
    // and UI, and must match whatever tags the same value onto exported OTel spans
    // (see the otel-collector addon's own clusterName) -- the UI's Traces tab filters
    // rows client-side by this exact string, so a mismatch here silently empties it.
    this.clusterName = config.clusterName || 'mgmt-cluster';
    // The 1.0.0-alpha line absorbed the management/UI chart and moved OIDC to
    // enterprise.oidc.*/enterprise.rbac.roleMappings.*/enterprise.ui.frontend.oidc.clientId
    // (see _deployEnterprise). Gated on version so existing profiles on the old chart
    // (0.x) keep their exact prior behavior.
    this.isAlphaChart = this.enterprise && /^1\./.test(this.version);
    // otel's Helm value path changed between 1.0.0-alpha5 and -alpha6: alpha5 nests tracing
    // under otel.tracing.enabled/otel.tracing.exporter.otlp.endpoint, alpha6 moved it to
    // otel.traces.enabled/otel.traces.endpoint. Helm silently drops unknown keys rather than
    // erroring, so sending the wrong one leaves tracing disabled with no feedback -- live-
    // confirmed (2026-10-04) as the reason ClickHouse's genai_spans/kagent_chat_spans stayed
    // empty on alpha5 despite real chat activity and a healthy otel-collector pipeline (confirmed
    // by substrate's own spans landing fine in the same otel_traces_json table).
    const alphaGen = /^1\.0\.0-alpha(\d+)/.exec(this.version);
    this.usesLegacyOtelSchema = !!alphaGen && Number(alphaGen[1]) <= 5;

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

    // Backend/API client (old chart: kagent-backend, alpha chart: kagent-enterprise)
    this.oidcClientId =
      oidc.clientId ||
      (this.isAlphaChart ? 'kagent-enterprise' : this.enterprise ? 'kagent-backend' : 'kagent');
    this.oidcClientSecret = oidc.clientSecret || null;
    // Alpha chart only: the frontend's own public client, distinct from the backend's.
    this.oidcUiClientId = oidc.uiClientId || 'kagent-ui';

    // OSS-only: oauth2-proxy
    this.oidcCookieSecret = oidc.cookieSecret || null;
    this.oidcRedirectUrl = oidc.redirectUrl || null;

    // HTTPS UI exposure (alpha chart only -- see _applyAlphaUiExposure)
    this.hostname = config.hostname || null;
    const tls = config.tls || {};
    this.tlsSecretName = tls.secretName || 'kagent-ui-tls';
    this.tlsIssuer = tls.issuer || 'letsencrypt-dns';
    this.gatewayClassName = config.gatewayClassName || 'enterprise-agentgateway';
    this.gatewaySourceRanges = config.gatewaySourceRanges || null;

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
    // Off by default upstream (OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT):
    // without it, chat spans carry no prompt/response text (source-confirmed, 2026-09-28,
    // github.com/kagent-dev/kagent/go core/internal/translator/otel.go). Suspected -- not yet
    // reproduced end to end -- as the reason kagent-ui's own tracing page renders no traces
    // even though real spans and trace groups already exist in ClickHouse.
    this.captureSensitiveContent = !!otel.captureSensitiveContent;

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

    // Agent Substrate (kagent 1.0.0-alpha line; standalone chart in ate-system)
    const substrate = config.substrate || {};
    const substrateWorkerPool = substrate.workerPool || {};
    const substrateSnapshots = substrate.snapshots || {};
    const substrateVersion = substrate.version || SUBSTRATE_VERSION;
    this.substrate = {
      enabled: substrate.enabled === true,
      version: substrateVersion,
      namespace: substrate.namespace || SUBSTRATE_NAMESPACE,
      kubectlAteVersion: substrate.kubectlAteVersion || KUBECTL_ATE_VERSION,
      workerPool: {
        name: substrateWorkerPool.name || 'kagent-default',
        replicas: substrateWorkerPool.replicas || 1,
        // Must match the substrate chart version exactly (ate-controller starts a Worker
        // with the flags of its own version) -- derived from it rather than independently
        // configured, so the two can never drift apart. Override only for a custom build.
        workerImage:
          substrateWorkerPool.workerImage ||
          `${SUBSTRATE_WORKER_IMAGE_REGISTRY}/ateom-gvisor:v${substrateVersion}`,
        sandboxClass: substrateWorkerPool.sandboxClass || 'gvisor',
      },
      snapshots: {
        // Ready-to-apply KSA annotation (kubectl annotate key=value) identifying the
        // cloud identity bound to the atelet worker's storage -- sourced from the infra
        // provisioner's own terraform output (see TemplateResolver's
        // infra.clusters.<name>.storage.* and terraform-cloud.js's extractStorageInfo).
        // Null when substrate snapshot storage wasn't provisioned for this cluster, which
        // leaves the atelet worker on its bundled RustFS default (no external creds).
        identityAnnotationKey: substrateSnapshots.identityAnnotation?.key || null,
        identityAnnotationValue: substrateSnapshots.identityAnnotation?.value || null,
        // Selects the atelet worker's storage client -- derived from the annotation key
        // rather than separately configured, so it can never drift out of sync with it.
        // The bucket and path stay per-Harness (substrate-agent feature's own
        // snapshots.bucket), never configured globally on the worker.
        backend:
          ANNOTATION_KEY_TO_STORAGE_BACKEND[substrateSnapshots.identityAnnotation?.key] || 's3',
      },
    };
  }

  validate() {
    if (this.enterprise && !process.env.ENTERPRISE_KAGENT_LICENSE) {
      throw new Error(
        'ENTERPRISE_KAGENT_LICENSE environment variable is required for kagent Enterprise'
      );
    }
    if (this.substrate.enabled && !process.env.ENTERPRISE_AGENTGATEWAY_LICENSE) {
      throw new Error(
        'ENTERPRISE_AGENTGATEWAY_LICENSE environment variable is required for Agent Substrate (licenses atenet-egress/atenet-router, which run agentgateway-enterprise)'
      );
    }
    if (
      this.substrate.enabled &&
      this.substrate.snapshots.identityAnnotationKey &&
      !this.substrate.snapshots.identityAnnotationValue
    ) {
      throw new Error(
        'substrate.snapshots.identityAnnotation.value is required when identityAnnotation.key is set'
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
    const crdsArgs = [
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
    ];
    // WorkerPool CRD only renders when substrate.enabled=true on this release.
    if (this.enterprise && this.substrate.enabled) {
      crdsArgs.push('--set', 'substrate.enabled=true');
    }
    await KubernetesHelper.helm(crdsArgs, { spinner: this.spinner });

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

    if (this.substrate.enabled) {
      // The substrate chart bundles atenet-egress/atenet-router, which run the
      // agentgateway-enterprise binary -- a different product from kagent-enterprise, with
      // its own license, strictly validated at startup ("license does not cover the
      // required product", confirmed live). Not ENTERPRISE_KAGENT_LICENSE -- reuse the same
      // env var the agentgateway addon itself already uses successfully.
      const substrateLicenseKey = process.env.ENTERPRISE_AGENTGATEWAY_LICENSE;
      await this._installSubstrateRelease(helmCtxArgs, substrateLicenseKey);
      await this._ensureAteletWorkloadIdentity();
      const atePath = await this._ensureKubectlAte();
      await this._bootstrapSubstrateCrypto(atePath);
      // Re-apply with the same values now that the crypto pools/authentication ConfigMap
      // exist, so pods that were waiting on that material pick it up -- the first install
      // above runs before any of it exists (--wait=false there; --wait here).
      await this._installSubstrateRelease(helmCtxArgs, substrateLicenseKey, { wait: true });
      await this._waitForSubstrateReady();
    }

    // Alpha chart: the OIDC secretRef and the UI's Gateway/Certificate must exist before
    // the controller renders enterprise.oidc.secretRef / ui.httpRoute.parentRefs below.
    await this._ensureKagentEnterpriseOidcSecret();
    await this._ensureUiGateway();

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
      '--set-string',
      `global.licensing.licenseKey=${licenseKey}`,
      ...helmCtxArgs,
    ];

    if (this.isAlphaChart) {
      // 1.0.0-alpha line: OIDC lives under enterprise.oidc.*/enterprise.rbac.roleMappings.*,
      // and the frontend registers its own public client separately from the backend's.
      // No jwksUrl override and no #1829 envFrom workaround here -- both were fixes for the
      // old chart's specific bugs (EKS OIDC discovery trust, a ConfigMap envFrom gap); neither
      // is confirmed to apply to the alpha chart, so they're not carried over speculatively.
      // config/values.yaml is the old chart's schema (rbac.roleMapping.*) and the alpha chart's
      // own validation.yaml fails the render if that key is present at all -- even set to null,
      // since Helm's null-deletes-a-key merge isn't guaranteed across a --values file and a
      // --set override. So skip that file here and re-apply its two settings directly: bundled
      // postgres, and the same CEL guard at its new path (commas escaped -- Helm's --set parser,
      // unlike a values file, splits unescaped commas as separate assignments).
      controllerArgs.push(
        '--set',
        'database.postgres.bundled.enabled=true',
        '--set-string',
        'enterprise.rbac.roleMapper=has(claims.Groups) ? claims.Groups.transformList(i\\, v\\, v in rolesMap\\, rolesMap[v]) : []',
        // Explicit rather than left to the chart's own platformLocalClusterName fallback
        // (also "mgmt-cluster"), so this value is visible in one place instead of an
        // implicit agreement between this addon's default and the chart's default.
        '--set-string',
        `global.cluster=${this.clusterName}`
      );

      if (this.oidcIssuer) {
        controllerArgs.push(
          '--set',
          `enterprise.oidc.issuer=${this.oidcIssuer}`,
          '--set',
          `enterprise.oidc.clientId=${this.oidcClientId}`,
          '--set',
          'enterprise.oidc.secretRef=kagent-enterprise-oidc-secret',
          '--set',
          'enterprise.oidc.secretKey=clientSecret',
          '--set',
          `enterprise.rbac.roleMappings.${this.rbacAdminsGroup}=global.Admin`,
          '--set',
          `enterprise.rbac.roleMappings.${this.rbacWritersGroup}=global.Writer`,
          '--set',
          `enterprise.rbac.roleMappings.${this.rbacReadersGroup}=global.Reader`,
          '--set',
          `enterprise.rbac.roleMappings.${this.rbacAgentregistryGroup}=global.Writer`,
          '--set',
          `enterprise.ui.frontend.oidc.clientId=${this.oidcUiClientId}`
        );
      }
    } else {
      controllerArgs.push('--values', path.join(CONFIG_DIR, 'values.yaml'));

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
    }

    this._appendProviderArgs(controllerArgs);
    this._appendDatabaseArgs(controllerArgs);

    if (this.otlpEndpoint) {
      controllerArgs.push(
        '--set',
        this.usesLegacyOtelSchema ? 'otel.tracing.enabled=true' : 'otel.traces.enabled=true',
        '--set',
        this.usesLegacyOtelSchema
          ? `otel.tracing.exporter.otlp.endpoint=${this.otlpEndpoint}`
          : `otel.traces.endpoint=${this.otlpEndpoint}`
      );
      if (this.captureSensitiveContent) {
        // Controller reads this env var itself at startup and mirrors it onto every
        // Harness workload's own env too (core/internal/translator/otel.go
        // TelemetryEnvironment) -- one flag turns on prompt/response capture cluster-wide.
        controllerArgs.push(
          '--set-json',
          'controller.env=[{"name":"OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT","value":"SPAN_ONLY"}]'
        );
      }
    }

    for (const flag of this._buildSubstrateControllerArgs()) {
      controllerArgs.push('--set', flag);
    }

    this._appendUiHttpRouteArgs(controllerArgs);

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
        'otel.traces.enabled=true',
        '--set',
        `otel.traces.endpoint=${this.otlpEndpoint}`
      );
    }

    this._appendProviderArgs(ossArgs);
    this._appendDatabaseArgs(ossArgs);

    await KubernetesHelper.helm(ossArgs, { spinner: this.spinner });
    await KubernetesHelper.assertHelmDeployed(CONTROLLER_RELEASE, this.namespace, this.kubeContext);
  }

  /**
   * Download URL for the kubectl-ate CLI release asset matching this platform.
   */
  _kubectlAteDownloadUrl() {
    const osMap = { darwin: 'darwin', linux: 'linux' };
    const archMap = { x64: 'amd64', arm64: 'arm64' };
    const os = osMap[process.platform] || process.platform;
    const arch = archMap[process.arch] || process.arch;
    return `https://github.com/kagent-dev/substrate/releases/download/${this.substrate.kubectlAteVersion}/kubectl-ate-${os}-${arch}`;
  }

  /**
   * Substrate-related --set flags for the kagent controller release (bare
   * key=value strings; caller decides --set vs --set-string). Points the
   * controller at the standalone substrate release (fixed service names --
   * substrate.fullname/role.yaml hardcode "ate-system") and creates a
   * WorkerPool from this release for Harnesses to reference via
   * spec.substrate.workerPoolRef (no controller-level default pool anymore).
   */
  _buildSubstrateControllerArgs() {
    if (!this.substrate.enabled) return [];
    const ateNs = this.substrate.namespace;
    const wp = this.substrate.workerPool;
    return [
      // The substrate release itself (installed separately, see _installSubstrateRelease)
      // is not a subchart of this release, so this stays false here.
      'substrate.enabled=false',
      'controller.substrate.enabled=true',
      `controller.substrate.ateApiEndpoint=dns:///api.${ateNs}.svc:443`,
      `controller.substrate.atenetRouterURL=http://atenet-router.${ateNs}.svc:80`,
      'substrateWorkerPool.create=true',
      `substrateWorkerPool.name=${wp.name}`,
      `substrateWorkerPool.replicas=${wp.replicas}`,
      `substrateWorkerPool.workerImage=${wp.workerImage}`,
      `substrateWorkerPool.sandboxClass=${wp.sandboxClass}`,
    ];
  }

  /**
   * Reconcile the Secret the alpha chart's enterprise.oidc.secretRef points at.
   * Always re-applied (not skip-if-exists) since the client secret can rotate.
   */
  async _ensureKagentEnterpriseOidcSecret() {
    if (!this.isAlphaChart || !this.oidcIssuer || !this.oidcClientSecret) return;

    const ctxFlag = this.kubeContext ? `--context=${this.kubeContext}` : '';
    const ctxStr = ctxFlag ? `${ctxFlag} ` : '';

    this.log('Reconciling kagent-enterprise-oidc-secret');
    const result = await CommandRunner.exec(
      `kubectl ${ctxStr}create secret generic kagent-enterprise-oidc-secret -n ${this.namespace} --from-literal=clientSecret="${this.oidcClientSecret}" --dry-run=client -o yaml | kubectl ${ctxStr}apply -f -`,
      { ignoreError: true }
    );
    if (result.exitCode) {
      throw new Error(
        `Failed to reconcile kagent-enterprise-oidc-secret: ${result.stderr?.trim()}`
      );
    }
  }

  /**
   * Certificate + Gateway for the UI's HTTPS listener (alpha chart only). The chart's own
   * ui.httpRoute.* values (see _appendUiHttpRouteArgs) attach an HTTPRoute to this Gateway --
   * created here rather than by the chart since a Gateway is cluster infrastructure, not a
   * per-release object.
   */
  async _ensureUiGateway() {
    if (!this.isAlphaChart || !this.hostname) return;

    await this.applyResource(
      {
        apiVersion: 'cert-manager.io/v1',
        kind: 'Certificate',
        metadata: { name: this.tlsSecretName, namespace: this.namespace },
        spec: {
          secretName: this.tlsSecretName,
          issuerRef: { name: this.tlsIssuer, kind: 'ClusterIssuer' },
          dnsNames: [this.hostname],
        },
      },
      this.kubeContext
    );

    const spec = {
      gatewayClassName: this.gatewayClassName,
      listeners: [
        {
          name: 'https',
          port: 443,
          protocol: 'HTTPS',
          hostname: this.hostname,
          tls: {
            mode: 'Terminate',
            certificateRefs: [{ name: this.tlsSecretName, kind: 'Secret' }],
          },
          allowedRoutes: { namespaces: { from: 'Same' } },
        },
      ],
    };

    if (this.gatewaySourceRanges) {
      // Native spec.loadBalancerSourceRanges, not an AWS-only annotation --
      // this Gateway's LB is a GCP one.
      await this.applyResource(
        {
          apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
          kind: 'EnterpriseAgentgatewayParameters',
          metadata: { name: 'kagent-ui-https-params', namespace: this.namespace },
          spec: { service: { spec: { loadBalancerSourceRanges: this.gatewaySourceRanges } } },
        },
        this.kubeContext
      );
      spec.infrastructure = {
        parametersRef: {
          name: 'kagent-ui-https-params',
          group: 'enterpriseagentgateway.solo.io',
          kind: 'EnterpriseAgentgatewayParameters',
        },
      };
    }

    await this.applyResource(
      {
        apiVersion: 'gateway.networking.k8s.io/v1',
        kind: 'Gateway',
        metadata: { name: 'kagent-ui-https', namespace: this.namespace },
        spec,
      },
      this.kubeContext
    );

    this.log(`UI Gateway 'kagent-ui-https' created for https://${this.hostname}`, 'info');
  }

  /**
   * Turn on the chart's native ui.httpRoute.* values so it renders its own HTTPRoute
   * (kagent-ui-httproute.yaml) attached to the Gateway from _ensureUiGateway.
   */
  _appendUiHttpRouteArgs(args) {
    if (!this.isAlphaChart || !this.hostname) return;

    const parentRefs = [
      {
        group: 'gateway.networking.k8s.io',
        kind: 'Gateway',
        name: 'kagent-ui-https',
        namespace: this.namespace,
      },
    ];
    // Explicit backendRefs rather than relying on the chart's own rule-omits-backendRefs
    // default: that default silently failed to apply on a live upgrade (Helm's own recorded
    // manifest showed the correct rendered rules, but the object on the cluster never actually
    // changed), leaving a stale rule with a match but no backend -- "no valid backends" at the
    // gateway. Being explicit here means every apply carries real content, not a diff from
    // empty to empty that a stuck update could silently no-op on.
    const rules = [
      {
        matches: [{ path: { type: 'PathPrefix', value: '/' } }],
        backendRefs: [{ group: '', kind: 'Service', name: `${CONTROLLER_RELEASE}-ui`, port: 8080 }],
      },
    ];
    args.push(
      '--set',
      'ui.httpRoute.enabled=true',
      '--set-json',
      `ui.httpRoute.parentRefs=${JSON.stringify(parentRefs)}`,
      '--set-json',
      `ui.httpRoute.hostnames=${JSON.stringify([this.hostname])}`,
      '--set-json',
      `ui.httpRoute.rules=${JSON.stringify(rules)}`
    );
  }

  /**
   * Install (or re-apply) the standalone Agent Substrate Helm release into its own
   * namespace (ate-system by convention -- see the substrate config doc comment). Called
   * twice: first with wait=false, since the chart doesn't create the cryptographic Secrets
   * its own pods need to become Ready (see _bootstrapSubstrateCrypto, called right after);
   * then again with wait=true once that material exists, matching
   * docs.solo.io/kagent/1.0.x/setup/installation/'s documented re-rollout step, so pods
   * that were waiting on it pick it up.
   */
  async _installSubstrateRelease(helmCtxArgs, licenseKey, { wait = false } = {}) {
    this.log(`Installing Agent Substrate ${this.substrate.version}`);

    const values = {
      global: { licensing: { licenseKey } },
      credentialProvider: {
        namespacePolicies: [{ atespace: this.namespace, allowedNamespaces: [this.namespace] }],
      },
    };
    if (this.otlpEndpoint) {
      values.otel = { endpoint: this.otlpEndpoint, traces: { enabled: false } };
    }
    if (this.substrate.snapshots.backend === 'gcs') {
      values.atelet = { storageBackend: 'gcs', gcpAuthForImagePulls: true };
    }

    const valuesFile = path.join(tmpdir(), `substrate-values-${Date.now()}.yaml`);
    try {
      await writeFile(valuesFile, yaml.dump(values, { lineWidth: -1 }), 'utf8');
      await KubernetesHelper.helm(
        [
          'upgrade',
          '-i',
          SUBSTRATE_RELEASE,
          `${SUBSTRATE_REGISTRY}/substrate`,
          '-n',
          this.substrate.namespace,
          '--version',
          this.substrate.version,
          '--create-namespace',
          wait ? '--wait' : '--wait=false',
          '-f',
          valuesFile,
          ...helmCtxArgs,
        ],
        { spinner: this.spinner }
      );
    } finally {
      try {
        await unlink(valuesFile);
      } catch {
        /* ignore */
      }
    }

    this.log(
      wait
        ? 'Agent Substrate release re-applied'
        : 'Agent Substrate release installed (pods stay unready until the crypto pools are bootstrapped next)',
      'info'
    );
  }

  /**
   * Annotate the atelet worker's and ate-api-server's KSAs with whichever cloud-identity
   * annotation the infra provisioner produced (GCP Workload Identity or AWS IRSA -- see
   * substrate.snapshots.identityAnnotation), so both can reach the snapshot bucket without a
   * key file. Cloud-agnostic: just applies whatever key/value pair it was given. ate-api-server
   * needs this too, not just atelet -- it directly manages "Tags" (durable published golden
   * snapshots) in the bucket itself; live-confirmed (2026-10-04) that without it, the
   * ActorTemplateReconciler's tagGoldenActor step fails forever with "storage.objects.list"
   * 403s, leaving every Agent stuck at Ready: False/ActorTemplatePending even after its golden
   * actor successfully suspends and snapshots. The substrate chart's own ServiceAccount
   * templates (atelet.yaml, ate-api-server's) set no annotations of their own, so this survives
   * future `helm upgrade` runs -- Helm only reconciles fields its rendered manifest actually sets.
   */
  async _ensureAteletWorkloadIdentity() {
    const { identityAnnotationKey, identityAnnotationValue } = this.substrate.snapshots;
    if (!identityAnnotationKey || !identityAnnotationValue) return;

    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    for (const serviceAccount of ['atelet', 'ate-api-server']) {
      this.log(
        `Binding ${serviceAccount} KSA to ${identityAnnotationValue} via ${identityAnnotationKey}`
      );
      await KubernetesHelper.kubectl(
        [
          ...ctxArgs,
          'annotate',
          'serviceaccount',
          serviceAccount,
          '-n',
          this.substrate.namespace,
          `${identityAnnotationKey}=${identityAnnotationValue}`,
          '--overwrite',
        ],
        { spinner: this.spinner }
      );
    }
  }

  /**
   * Download kubectl-ate (idempotent -- reuses a cached, version-named binary
   * across runs) and return its path. Used to bootstrap the cryptographic
   * pools the substrate chart deliberately doesn't create.
   */
  async _ensureKubectlAte() {
    const workDir = path.join(tmpdir(), 'agentic-kubectl-ate');
    const atePath = path.join(workDir, `kubectl-ate-${this.substrate.kubectlAteVersion}`);

    await CommandRunner.exec(`mkdir -p "${workDir}"`, { ignoreError: true });

    const check = await CommandRunner.exec(`"${atePath}" --help`, { ignoreError: true });
    if (!check.exitCode) {
      this.log(
        `kubectl-ate ${this.substrate.kubectlAteVersion} already present, skipping download`,
        'info'
      );
      return atePath;
    }

    this.log(`Downloading kubectl-ate ${this.substrate.kubectlAteVersion}`);
    const url = this._kubectlAteDownloadUrl();
    const download = await CommandRunner.exec(`curl -fsSL -o "${atePath}" "${url}"`, {
      ignoreError: true,
    });
    if (download.exitCode) {
      throw new Error(`Failed to download kubectl-ate from ${url}: ${download.stderr?.trim()}`);
    }
    await CommandRunner.exec(`chmod +x "${atePath}"`, { ignoreError: true });
    return atePath;
  }

  /**
   * Bootstrap the cryptographic material the substrate chart deliberately
   * doesn't create: 5 CA/JWT pools, the actor-id CA republished as a plain
   * PEM secret, and the JWT authentication ConfigMap ate-api-server reads.
   * Each step checks before creating so re-deploys are safe.
   */
  async _bootstrapSubstrateCrypto(atePath) {
    const ctxFlag = this.kubeContext ? `--context=${this.kubeContext}` : '';
    const ctxStr = ctxFlag ? `${ctxFlag} ` : '';
    const ateNs = this.substrate.namespace;

    this.log('Bootstrapping Agent Substrate cryptographic pools');

    await CommandRunner.exec(
      `kubectl ${ctxStr}create namespace ${PODCERT_NAMESPACE} --dry-run=client -o yaml | kubectl ${ctxStr}apply -f -`,
      { ignoreError: true }
    );

    const pools = [
      {
        name: 'service-dns-ca-pool',
        namespace: PODCERT_NAMESPACE,
        cmd: `admin make-ca-pool --ca-id=1 --name=service-dns-ca-pool --secret-namespace=${PODCERT_NAMESPACE}`,
      },
      {
        name: 'pod-identity-ca-pool',
        namespace: PODCERT_NAMESPACE,
        cmd: `admin make-ca-pool --ca-id=1 --name=pod-identity-ca-pool --secret-namespace=${PODCERT_NAMESPACE}`,
      },
      {
        name: 'actor-id-jwt-pool',
        namespace: ateNs,
        cmd: `admin make-jwt-pool --key-id=1 --name=actor-id-jwt-pool --secret-namespace=${ateNs}`,
      },
      {
        name: 'actor-id-ca-pool',
        namespace: ateNs,
        cmd: `admin make-ca-pool --ca-id=1 --name=actor-id-ca-pool --secret-namespace=${ateNs}`,
      },
      {
        name: 'egress-mitm-ca-pool',
        namespace: ateNs,
        // ECDSAP256, not the tool's ED25519 default: broader TLS client compatibility for
        // certs the egress proxy mints on the fly when intercepting outbound traffic.
        cmd: `admin make-ca-pool --ca-id=1 --name=egress-mitm-ca-pool --secret-namespace=${ateNs} --key-type=ECDSAP256`,
      },
    ];

    for (const pool of pools) {
      const exists = await CommandRunner.exec(
        `kubectl ${ctxStr}get secret ${pool.name} -n ${pool.namespace} --ignore-not-found`,
        { ignoreError: true }
      );
      if (!exists.exitCode && exists.stdout?.trim()) {
        this.log(`${pool.name} already exists, skipping`, 'info');
        continue;
      }
      const result = await CommandRunner.exec(
        `"${atePath}" ${pool.cmd}${ctxFlag ? ` ${ctxFlag}` : ''}`,
        {
          ignoreError: true,
        }
      );
      if (result.exitCode) {
        throw new Error(`Failed to create ${pool.name}: ${result.stderr?.trim()}`);
      }
    }

    // Republish the actor-id CA root as a plain PEM secret for ate-api-server.
    const caCertsExists = await CommandRunner.exec(
      `kubectl ${ctxStr}get secret actor-id-ca-certs -n ${ateNs} --ignore-not-found`,
      { ignoreError: true }
    );
    if (!caCertsExists.exitCode && caCertsExists.stdout?.trim()) {
      this.log('actor-id-ca-certs already exists, skipping', 'info');
    } else {
      const caFile = path.join(tmpdir(), `actor-id-ca-${Date.now()}.crt`);
      try {
        const extract = await CommandRunner.exec(
          `kubectl ${ctxStr}get secret actor-id-ca-pool -n ${ateNs} -o jsonpath='{.data.pool}' | base64 --decode | jq -r '.CAs[0].RootCertificateDER' | base64 --decode | openssl x509 -inform der -outform pem > "${caFile}"`,
          { ignoreError: true }
        );
        if (extract.exitCode) {
          throw new Error(`Failed to extract actor-id CA root: ${extract.stderr?.trim()}`);
        }
        const createSecret = await CommandRunner.exec(
          `kubectl ${ctxStr}create secret generic actor-id-ca-certs -n ${ateNs} --from-file=ca.crt="${caFile}"`,
          { ignoreError: true }
        );
        if (createSecret.exitCode) {
          throw new Error(
            `Failed to create actor-id-ca-certs secret: ${createSecret.stderr?.trim()}`
          );
        }
      } finally {
        try {
          await unlink(caFile);
        } catch {
          /* ignore */
        }
      }
    }

    // JWT authentication config for ate-api-server: which issuer/audience it trusts. The real
    // issuer is a property of this specific cluster (e.g. GKE mints tokens with an external
    // container.googleapis.com issuer, not the classic in-cluster default), so discover it via
    // the standard, unauthenticated OIDC discovery endpoint every conformant cluster serves,
    // rather than assuming one. certificateAuthorityFile/discoveryTokenFile only apply to
    // verifying against the local API server's own JWKS -- an external issuer is verified via
    // public OIDC discovery instead, so they're included only when the issuer is the default.
    const DEFAULT_ISSUER = 'https://kubernetes.default.svc';
    let issuer = DEFAULT_ISSUER;
    const discovery = await CommandRunner.exec(
      `kubectl ${ctxStr}get --raw /.well-known/openid-configuration`,
      { ignoreError: true }
    );
    if (!discovery.exitCode && discovery.stdout?.trim()) {
      try {
        issuer = JSON.parse(discovery.stdout).issuer || DEFAULT_ISSUER;
      } catch {
        /* keep default */
      }
    }
    const inClusterAuthLines =
      issuer === DEFAULT_ISSUER
        ? `  certificateAuthorityFile: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
  discoveryTokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token
`
        : '';
    const authYaml = `actorIdentityJWTProvider: kubernetes
jwtProviders:
- name: kubernetes
  issuer: ${issuer}
  audiences: [api.${ateNs}.svc]
${inClusterAuthLines}`;
    const authResult = await CommandRunner.exec(
      `kubectl ${ctxStr}create configmap ate-api-authentication -n ${ateNs} --from-literal=authentication.yaml='${authYaml}' --dry-run=client -o yaml | kubectl ${ctxStr}apply -f -`,
      { ignoreError: true }
    );
    if (authResult.exitCode) {
      throw new Error(
        `Failed to create ate-api-authentication ConfigMap: ${authResult.stderr?.trim()}`
      );
    }

    this.log('Agent Substrate cryptographic pools bootstrapped', 'success');
  }

  /**
   * Wait for the substrate control plane to come up, mirroring the upstream
   * workshop's own readiness check. Uses `rollout status` rather than
   * `--for=condition=available` because it also has to cover the atelet
   * DaemonSet, which has no `available` condition.
   */
  async _waitForSubstrateReady() {
    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    const ateNs = this.substrate.namespace;

    this.log('Waiting for Agent Substrate control plane to be ready');

    await KubernetesHelper.kubectl(
      [
        ...ctxArgs,
        'rollout',
        'status',
        'deploy/podcertificate-controller',
        '-n',
        PODCERT_NAMESPACE,
        '--timeout=300s',
      ],
      { spinner: this.spinner }
    );

    const ateDeployments = [
      'ate-api-server',
      'ate-controller',
      'atenet-router',
      'atenet-egress',
      'k8s-credential-provider',
    ];
    for (const deployment of ateDeployments) {
      await KubernetesHelper.kubectl(
        [...ctxArgs, 'rollout', 'status', `deploy/${deployment}`, '-n', ateNs, '--timeout=300s'],
        { spinner: this.spinner }
      );
    }

    await KubernetesHelper.kubectl(
      [...ctxArgs, 'rollout', 'status', 'ds/atelet', '-n', ateNs, '--timeout=300s'],
      { spinner: this.spinner }
    );

    this.log('Agent Substrate control plane ready', 'success');
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

    // Alpha chart: UI Gateway/Certificate/OIDC secret (chart uninstall below removes the
    // HTTPRoute itself, since ui.httpRoute is chart-owned)
    if (this.isAlphaChart) {
      if (this.hostname) {
        await this.deleteResource(
          'Gateway',
          'kagent-ui-https',
          this.namespace,
          this.kubeContext
        ).catch(() => {});
        await this.deleteResource(
          'Certificate',
          this.tlsSecretName,
          this.namespace,
          this.kubeContext
        ).catch(() => {});
      }
      if (this.oidcIssuer && this.oidcClientSecret) {
        await this.deleteResource(
          'Secret',
          'kagent-enterprise-oidc-secret',
          this.namespace,
          this.kubeContext
        ).catch(() => {});
      }
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

    // Substrate: uninstall after kagent (controller + CRDs), matching upstream's own
    // teardown order. GCS bucket contents (if that backend was used) are deliberately
    // not deleted here -- cross-session data, left for manual cleanup.
    if (this.enterprise && this.substrate.enabled) {
      try {
        await KubernetesHelper.helm(
          ['uninstall', SUBSTRATE_RELEASE, '-n', this.substrate.namespace, ...helmCtxArgs],
          { spinner: this.spinner }
        );
      } catch (err) {
        if (!/not found|no deployed releases/i.test(err.message)) throw err;
      }

      await KubernetesHelper.kubectl([
        ...kubectlCtxArgs,
        'delete',
        'namespace',
        this.substrate.namespace,
        '--ignore-not-found=true',
      ]);
      await KubernetesHelper.kubectl([
        ...kubectlCtxArgs,
        'delete',
        'namespace',
        PODCERT_NAMESPACE,
        '--ignore-not-found=true',
      ]);
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
