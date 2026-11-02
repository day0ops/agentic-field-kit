// addons/kagent/runbook.js
import { resolveRunbookTemplates } from '../../src/lib/runbook-adapters/template-vars.js';

// tpl: return v if it's a real value (not an unresolved {{...}} template), otherwise fb
const tpl = (v, fb) => (v && !/\{\{/.test(v) ? v : fb);

const OSS_VERSION = '0.7.7';
const ENTERPRISE_VERSION = '0.4.4';
const OSS_CRDS_OCI = 'oci://ghcr.io/kagent-dev/kagent/helm/kagent-crds';
const OSS_CONTROLLER_OCI = 'oci://ghcr.io/kagent-dev/kagent/helm/kagent';
const ENT_CRDS_OCI =
  'oci://us-docker.pkg.dev/solo-public/kagent-enterprise-helm/charts/kagent-enterprise-crds';
const ENT_CONTROLLER_OCI =
  'oci://us-docker.pkg.dev/solo-public/kagent-enterprise-helm/charts/kagent-enterprise';

// Agent Substrate defaults -- keep in sync with addons/kagent/index.js
const SUBSTRATE_VERSION = '1.0.0-rc.1-76ace06f';
const SUBSTRATE_OCI = 'oci://us-docker.pkg.dev/solo-public/enterprise-substrate-helm/substrate';
const SUBSTRATE_CRDS_OCI =
  'oci://us-docker.pkg.dev/solo-public/enterprise-substrate-helm/substrate-crds';
const SUBSTRATE_PODCERT_OCI =
  'oci://us-docker.pkg.dev/solo-public/enterprise-substrate-helm/substrate-podcert';
const SUBSTRATE_WORKER_IMAGE_REGISTRY = 'us-docker.pkg.dev/solo-public/substrate-enterprise';
const SUBSTRATE_NAMESPACE = 'ate-system';
const PODCERT_NAMESPACE = 'podcertificate-controller-system';
// GitHub release tag format (v1.0.0-rc1), which differs from the Helm chart's own OCI
// version string (SUBSTRATE_VERSION, e.g. 1.0.0-rc.1-76ace06f) even for the same release.
const KUBECTL_ATE_VERSION = 'v1.0.0-rc1';

// Keep in sync with addons/kagent/index.js's ANNOTATION_KEY_TO_STORAGE_BACKEND.
const ANNOTATION_KEY_TO_STORAGE_BACKEND = {
  'iam.gke.io/gcp-service-account': 'gcs',
  'eks.amazonaws.com/role-arn': 's3',
};

// Keep in sync with addons/kagent/index.js's RBAC_CATALOG_RESOURCES.
const RBAC_CATALOG_RESOURCES = [
  'agents',
  'agent-templates',
  'harnesses',
  'model-configs',
  'runtimes',
];

export function envVarsFor(addonCfg, _clusterName) {
  const cfg = addonCfg.config || {};
  const enterprise = cfg.enterprise === true;
  const substrateEnabled = enterprise && (cfg.substrate || {}).enabled === true;
  const vars = [
    { name: 'OPENAI_API_KEY', description: 'OpenAI API key for LLM provider', required: false },
  ];
  if (substrateEnabled) {
    vars.unshift({
      name: 'ENTERPRISE_AGENTGATEWAY_LICENSE',
      description:
        'Licenses atenet-egress/atenet-router (agentgateway-enterprise) -- same env var the agentgateway addon itself uses',
      required: true,
    });
  }
  if (enterprise) {
    vars.unshift({
      name: 'ENTERPRISE_KAGENT_LICENSE',
      description: 'Solo Enterprise for kagent license key',
      required: true,
    });
  }
  return vars;
}

export function envExportsFor(addonCfg, _profile, env) {
  const cfg = addonCfg.config || {};
  const enterprise = cfg.enterprise === true;
  const version =
    resolveRunbookTemplates(addonCfg.version, { env }) ||
    (enterprise ? ENTERPRISE_VERSION : OSS_VERSION);
  const exports = [
    {
      name: 'KAGENT_VERSION',
      value: version,
      comment: `kagent ${enterprise ? 'Enterprise' : 'OSS'} version`,
    },
    {
      name: 'KAGENT_NAMESPACE',
      value: addonCfg.namespace || 'kagent-system',
      comment: 'kagent namespace',
    },
  ];

  if (enterprise && cfg.substrate?.enabled) {
    const substrate = cfg.substrate;
    exports.push(
      {
        name: 'SUBSTRATE_VERSION',
        value: substrate.version || SUBSTRATE_VERSION,
        comment: 'Agent Substrate chart version',
      },
      {
        name: 'SUBSTRATE_NAMESPACE',
        value: substrate.namespace || SUBSTRATE_NAMESPACE,
        comment: 'namespace the substrate release installs into (fixed by the chart)',
      },
      {
        name: 'KUBECTL_ATE_VERSION',
        value: substrate.kubectlAteVersion || KUBECTL_ATE_VERSION,
        comment: 'kubectl-ate CLI + release-asset version',
      }
    );
  }

  return exports;
}

export async function generate(_subIndex, addonCfg, clusterName, _profile, env) {
  const cfg = addonCfg.config || {};
  const enterprise = cfg.enterprise === true;
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;

  // Alpha chart line (1.0.0-alpha3+) moved OIDC to enterprise.oidc.*, registers a separate
  // frontend client, and uses EnterpriseKagentRBACPolicy CRs for catalog RBAC instead of the old
  // chart's rbac.roleMapping.* -- mirrors addons/kagent/index.js's isAlphaChart gate.
  const version =
    resolveRunbookTemplates(addonCfg.version, { env }) ||
    (enterprise ? ENTERPRISE_VERSION : OSS_VERSION);
  const isAlphaChart = enterprise && /^1\./.test(version);

  const oidc = cfg.oidc || {};
  const keycloakHostname =
    tpl(oidc.keycloakHostname, env.spec.domains?.core?.keycloak) || 'keycloak.example.com';
  const keycloakScheme = oidc.keycloakTlsEnabled ? 'https' : 'http';
  const realm = oidc.realm || 'kagent';
  const oidcIssuer = oidc.issuer || `${keycloakScheme}://${keycloakHostname}/realms/${realm}`;
  const clientId =
    oidc.clientId ||
    (isAlphaChart ? 'kagent-enterprise' : enterprise ? 'kagent-backend' : 'kagent');
  const clientSecret = oidc.clientSecret || '';
  const uiClientId = oidc.uiClientId || 'kagent-ui';

  // UI exposure (alpha chart only)
  const hostname = tpl(cfg.hostname, env.spec.domains?.core?.kagentUi) || null;
  const uiExposureEnabled = isAlphaChart && !!hostname;
  const tlsCfg = cfg.tls || {};
  const tlsSecretName = tlsCfg.secretName || 'kagent-ui-tls';
  const tlsIssuer = tlsCfg.issuer || 'letsencrypt-dns';
  const gatewayClassName = cfg.gatewayClassName || 'enterprise-agentgateway';
  const gatewaySourceRanges = Array.isArray(cfg.gatewaySourceRanges)
    ? cfg.gatewaySourceRanges
    : null;

  const provider = cfg.provider || {};
  const providerType = provider.type || 'openAI';
  const otel = cfg.otel || {};
  let otlpEndpoint =
    resolveRunbookTemplates(otel.endpoint, { env }) ||
    'opentelemetry-collector-traces.telemetry.svc.cluster.local:4317';
  if (!/^https?:\/\//.test(otlpEndpoint)) {
    otlpEndpoint = `http://${otlpEndpoint}`;
  }
  const captureSensitiveContent = !!otel.captureSensitiveContent;

  const database = cfg.database || {};
  const storageClass = database.storageClass || 'gp3';

  const rbac = cfg.rbac || {};
  const adminsGroup = rbac.adminsGroup || 'kagent-admins';
  const writersGroup = rbac.writersGroup || 'kagent-writers';
  const readersGroup = rbac.readersGroup || 'kagent-readers';
  const agentregistryGroup = rbac.agentregistryGroup || 'agentregistry';

  // Agent Substrate -- mirrors addons/kagent/index.js's constructor/_build* methods
  const substrateCfg = cfg.substrate || {};
  const substrateEnabled = enterprise && substrateCfg.enabled === true;
  const substrateWorkerPool = substrateCfg.workerPool || {};
  const substrateVersionForImage = substrateCfg.version || SUBSTRATE_VERSION;
  const substrateWp = {
    name: substrateWorkerPool.name || 'kagent-default',
    replicas: substrateWorkerPool.replicas || 1,
    workerImage:
      substrateWorkerPool.workerImage ||
      `${SUBSTRATE_WORKER_IMAGE_REGISTRY}/ateworker-gvisor:v${substrateVersionForImage}`,
    sandboxClass: substrateWorkerPool.sandboxClass || 'gvisor',
  };
  const substrateNs = substrateCfg.namespace || SUBSTRATE_NAMESPACE;
  const substrateIdentityAnnotation = (substrateCfg.snapshots || {}).identityAnnotation || {};
  const substrateSnapshotBackend =
    ANNOTATION_KEY_TO_STORAGE_BACKEND[substrateIdentityAnnotation.key] || 's3';

  const crdsOci = enterprise ? ENT_CRDS_OCI : OSS_CRDS_OCI;
  const controllerOci = enterprise ? ENT_CONTROLLER_OCI : OSS_CONTROLLER_OCI;
  const mode = enterprise ? 'Enterprise' : 'OSS';

  const crdsArgs = [
    `  ${crdsOci}`,
    `  --namespace $KAGENT_NAMESPACE`,
    `  --version $KAGENT_VERSION`,
  ];
  if (substrateEnabled) {
    // WorkerPool CRD only renders when substrate.enabled=true on this release.
    crdsArgs.push(`  --set substrate.enabled=true`);
  }
  crdsArgs.push(`  --wait`, `  --kube-context ${ctx}`);
  const crdsCmd = `helm upgrade --install kagent-crds \\\n${crdsArgs
    .map(a => `${a} \\`)
    .join('\n')
    .replace(/ \\$/, '')}`;

  // Controller helm args
  const controllerArgs = [
    `  ${controllerOci}`,
    `  --namespace $KAGENT_NAMESPACE`,
    `  --version $KAGENT_VERSION`,
  ];

  if (enterprise && isAlphaChart) {
    controllerArgs.push(
      `  --set-string licensing.licenseKey="$ENTERPRISE_KAGENT_LICENSE"`,
      `  --set database.postgres.bundled.enabled=true`,
      // Off by default -- without it the controller never mounts its postgres.podcert.ate.dev
      // client-cert volume, which the bundled Postgres's pg_hba.conf requires (cert-only auth).
      `  --set database.postgres.clientCertificate.enabled=true`,
      // Off by default -- without it the controller has no podidentity.podcert.ate.dev/
      // servicedns.podcert.ate.dev mTLS client identity, and its substrate gRPC client hangs
      // until it times out: "substrate: dial ate-api ... context deadline exceeded".
      `  --set controller.substrateClientCertificate.enabled=true`,
      `  --set enterprise.oidc.issuer="${oidcIssuer}"`,
      `  --set enterprise.oidc.clientId="${clientId}"`,
      // Must match the Keycloak client's own audience mapper value -- a client ID here instead
      // of a dedicated audience value makes the controller reject every token with a bare 401.
      `  --set "enterprise.oidc.allowedAudiences[0]=kagent-enterprise-api"`,
      `  --set enterprise.oidc.secretRef=kagent-enterprise-oidc-secret`,
      `  --set enterprise.oidc.secretKey=clientSecret`,
      `  --set enterprise.ui.frontend.oidc.clientId="${uiClientId}"`,
      // Chart default reserves a full 2 CPUs for the bundled ClickHouse -- too much on a
      // single-node demo cluster. Limit stays at the chart default so it can still burst.
      `  --set clickhouse.resources.requests.cpu=300m`
    );
  } else if (enterprise) {
    controllerArgs.push(
      `  --set-string licensing.licenseKey="$ENTERPRISE_KAGENT_LICENSE"`,
      `  --set oidc.issuer="${oidcIssuer}"`,
      `  --set oidc.clientId="${clientId}"`,
      `  --set-string oidc.secret="${clientSecret}"`,
      `  --set "rbac.roleMapping.roleMappings.${adminsGroup}=global.Admin"`,
      `  --set "rbac.roleMapping.roleMappings.${writersGroup}=global.Writer"`,
      `  --set "rbac.roleMapping.roleMappings.${readersGroup}=global.Reader"`
    );
  } else {
    controllerArgs.push(
      `  --set oauth2-proxy.enabled=true`,
      `  --set controller.auth.mode=secured`,
      `  --set oauth2-proxy.config.clientID="${clientId}"`,
      `  --set-string oauth2-proxy.config.clientSecret="${clientSecret}"`,
      `  --set oauth2-proxy.extraEnv[0].name=OIDC_ISSUER_URL`,
      `  --set oauth2-proxy.extraEnv[0].value="${oidcIssuer}"`
    );
  }

  controllerArgs.push(
    `  --set providers.default=${providerType}`,
    `  --set-string providers.${providerType}.apiKey="$OPENAI_API_KEY"`,
    `  --set otel.traces.enabled=true`,
    `  --set otel.traces.endpoint="${otlpEndpoint}"`,
    `  --set database.postgres.bundled.storageClassName=${storageClass}`
  );

  if (captureSensitiveContent) {
    // Controller reads this env var itself at startup and mirrors it onto every Harness
    // workload's own env too -- one flag turns on prompt/response capture cluster-wide.
    // Required for kagent-ui's own tracing page to render anything.
    controllerArgs.push(
      `  --set-json 'controller.env=[{"name":"OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT","value":"SPAN_ONLY"}]'`
    );
  }

  if (substrateEnabled) {
    controllerArgs.push(
      // The substrate release is installed separately (see the Agent Substrate step
      // above), not as a subchart of this release, so this stays false here.
      `  --set substrate.enabled=false`,
      `  --set controller.substrate.enabled=true`,
      `  --set controller.substrate.ateApiEndpoint="dns:///api.${substrateNs}.svc:443"`,
      `  --set controller.substrate.atenetRouterURL="http://atenet-router.${substrateNs}.svc:80"`,
      `  --set substrateWorkerPool.create=true`,
      `  --set substrateWorkerPool.name=${substrateWp.name}`,
      `  --set substrateWorkerPool.replicas=${substrateWp.replicas}`,
      `  --set substrateWorkerPool.workerImage=${substrateWp.workerImage}`,
      `  --set substrateWorkerPool.sandboxClass=${substrateWp.sandboxClass}`
    );
  }

  if (uiExposureEnabled) {
    const parentRefs = JSON.stringify([
      {
        group: 'gateway.networking.k8s.io',
        kind: 'Gateway',
        name: 'kagent-ui-https',
        namespace: '$KAGENT_NAMESPACE',
      },
    ]);
    // Explicit backendRefs rather than the chart's rule-omits-backendRefs default: that
    // default silently failed to apply on a live upgrade (Helm's own recorded manifest showed
    // the right rules, but the live object never changed), leaving a rule with a match but no
    // backend -- "no valid backends" at the gateway.
    const rules = JSON.stringify([
      {
        matches: [{ path: { type: 'PathPrefix', value: '/' } }],
        backendRefs: [{ group: '', kind: 'Service', name: 'kagent-ui', port: 8080 }],
      },
    ]);
    controllerArgs.push(
      `  --set ui.httpRoute.enabled=true`,
      `  --set-json 'ui.httpRoute.parentRefs=${parentRefs}'`,
      `  --set-json 'ui.httpRoute.hostnames=${JSON.stringify([hostname])}'`,
      `  --set-json 'ui.httpRoute.rules=${rules}'`
    );
  }

  controllerArgs.push(`  --wait`, `  --timeout 10m`, `  --kube-context ${ctx}`);

  const controllerCmd = `helm upgrade --install kagent \\\n${controllerArgs
    .map(a => `${a} \\`)
    .join('\n')
    .replace(/ \\$/, '')}`;

  let stepNum = 0;
  const nextStep = () => ++stepNum;

  let ambientBlock = '';
  if (cfg.ambient) {
    ambientBlock = `**Step ${nextStep()}: Label the namespace for ambient dataplane mode**

Required for this cluster's kagent-controller to be reachable via a *.mesh.internal cross-cluster
hostname at all -- outside the ambient mesh that hostname suffix doesn't resolve (confirmed live:
NXDOMAIN from a non-ambient namespace vs. a real answer from an ambient one).

\`\`\`bash
kubectl create namespace $KAGENT_NAMESPACE --context ${ctx} --dry-run=client -o yaml | kubectl apply --context ${ctx} -f -
kubectl label namespace $KAGENT_NAMESPACE istio.io/dataplane-mode=ambient --overwrite --context ${ctx}
\`\`\`

`;
  }

  const crdsStep = nextStep();
  const substrateStep = substrateEnabled ? nextStep() : null;
  const oidcSecretStep = isAlphaChart && oidcIssuer && clientSecret ? nextStep() : null;
  const uiExposureStep = uiExposureEnabled ? nextStep() : null;
  const controllerStep = nextStep();
  const rbacPolicyStep = isAlphaChart && oidcIssuer ? nextStep() : null;

  let substrateBlock = '';
  if (substrateEnabled) {
    const substrateValuesLines = [
      // atenet-egress/atenet-router run agentgateway-enterprise -- a different product from
      // kagent-enterprise, with its own license (confirmed live: kagent's own license is
      // rejected with "license does not cover the required product").
      'global:',
      '  licensing:',
      '    licenseKey: "$ENTERPRISE_AGENTGATEWAY_LICENSE"',
      // Required as of substrate 1.0.0-rc1: ActorTemplate.snapshotConfig.storageLocation (set
      // per-Harness by the substrate-agent feature's own snapshots.bucket config) is now
      // rejected with "Forbidden" unless this preview gate is explicitly enabled -- confirmed
      // live, silently accepted with no gate at all on the prior alpha12/0.6.0 line. Applies
      // cluster-wide to ate-api-server, ate-controller, and atelet.
      'preview:',
      '  - PerTemplateSnapshotLocation',
      'credentialProvider:',
      '  namespacePolicies:',
      '    - atespace: $KAGENT_NAMESPACE',
      '      allowedNamespaces: [$KAGENT_NAMESPACE]',
      // Off by default -- without it ate-api-server never mounts its postgres.podcert.ate.dev
      // client-cert volume, which the bundled Postgres's pg_hba.conf requires (cert-only auth).
      'postgres:',
      '  clientCertificates:',
      '    enabled: true',
      // Chart default is only ate-client in this namespace -- kagent-controller (a different
      // namespace/service account) reading Substrate inventory from the UI otherwise fails
      // "ate-api could not read inventory: PermissionDenied". ate-api-server's OpenFGA authz
      // checks the mTLS SPIFFE principal (spiffe://cluster.local/ns/<ns>/sa/<name>), not the
      // "system:serviceaccount:..." string the chart's own ate-client default uses -- that
      // format is for a different (non-mTLS) caller kind. Explicit list, not an append: this
      // key replaces the chart default entirely.
      'ateApi:',
      '  authorization:',
      '    bootstrapOwners:',
      '      - system:serviceaccount:$SUBSTRATE_NAMESPACE:ate-client',
      '      - spiffe://cluster.local/ns/$KAGENT_NAMESPACE/sa/kagent-controller',
      // Chart default is an empty list, which renders atenet-router's ingress
      // networkAuthorization rule as `source.spiffeId in []` -- never true for any caller,
      // so every A2A SendMessage call TLS-handshakes then gets reset (KAGENT_SEND_NOT_ACCEPTED,
      // no server-side log). Same SPIFFE principal as ateApi.authorization.bootstrapOwners above.
      'atenetRouter:',
      '  ingressAllowedSPIFFEIDs:',
      '    - spiffe://cluster.local/ns/$KAGENT_NAMESPACE/sa/kagent-controller',
    ];
    if (otlpEndpoint) {
      substrateValuesLines.push(
        'otel:',
        `  endpoint: "${otlpEndpoint}"`,
        '  traces:',
        '    enabled: true'
      );
    }
    if (substrateSnapshotBackend === 'gcs') {
      substrateValuesLines.push('atelet:', '  storageBackend: gcs', '  gcpAuthForImagePulls: true');
    }

    substrateBlock = `**Step ${substrateStep} - Install Agent Substrate:**

Agent Substrate is the sandboxed actor/worker runtime kagent runs agents in (gVisor by default).
Requires a Kubernetes cluster serving \`certificates.k8s.io/v1beta1\`/\`v1\` with
\`PodCertificateRequest\` enabled (GA in 1.37; EKS cannot enable this on its managed control
plane). Vanilla Kubernetes ships no signer for custom signer names though -- cluster admins
must bring their own, which is what the pod certificate controller below is.

Create the $SUBSTRATE_NAMESPACE namespace with PodSecurity admission relaxed to "privileged" --
atelet (the per-node sandbox agent) mounts hostPath volumes that any enforcing "baseline" or
"restricted" namespace rejects outright. A no-op if the cluster has no such default; needed since
a later Helm install's \`--create-namespace\` would otherwise create this namespace unlabeled:

\`\`\`bash
kubectl apply --context ${ctx} -f - <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: $SUBSTRATE_NAMESPACE
  labels:
    pod-security.kubernetes.io/enforce: privileged
    pod-security.kubernetes.io/audit: privileged
    pod-security.kubernetes.io/warn: privileged
EOF
\`\`\`

Download \`kubectl-ate\`, the CLI used to bootstrap substrate's cryptographic pools:

\`\`\`bash
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
curl -fsSL -o kubectl-ate \\
  "https://github.com/kagent-dev/substrate/releases/download/$KUBECTL_ATE_VERSION/kubectl-ate-\${OS}-\${ARCH}" &&
  chmod +x kubectl-ate
\`\`\`

Install the pod certificate controller (substrate-podcert chart) -- a standalone, once-per-cluster
release that answers PodCertificateRequests for the \`*.podcert.ate.dev\` signers substrate pods
request, and publishes their ClusterTrustBundles. Must exist before any substrate pod is created,
not just before it needs to be Ready -- its pods request certificates immediately on creation.
Create its 3 CA-pool Secrets first (idempotent -- skip any that already exist); the chart's pod
unconditionally mounts all three:

\`\`\`bash
./kubectl-ate admin make-ca-pool --ca-id=1 --name=service-dns-ca-pool  --secret-namespace=${PODCERT_NAMESPACE} --context=${ctx}
./kubectl-ate admin make-ca-pool --ca-id=1 --name=pod-identity-ca-pool --secret-namespace=${PODCERT_NAMESPACE} --context=${ctx}
./kubectl-ate admin make-ca-pool --ca-id=1 --name=postgres-ca-pool     --secret-namespace=${PODCERT_NAMESPACE} --context=${ctx}

helm upgrade --install substrate-podcert \\
  ${SUBSTRATE_PODCERT_OCI} \\
  --namespace ${PODCERT_NAMESPACE} \\
  --version $SUBSTRATE_VERSION \\
  --create-namespace \\
  --wait \\
  --set 'postgresClients[0]=$KAGENT_NAMESPACE/kagent-controller=kagent_readwrite_user\\,kagent_owner_user' \\
  --kube-context ${ctx}
\`\`\`

kagent-controller's own bundled-Postgres wiring (below) shares this instance rather than
deploying its own, under a different namespace/service account than ate-api-server (the
\`postgresClients\` default) -- the entry above authorizes it for the \`postgres.podcert.ate.dev\`
signer's client certs.

Deploy the bundled, cert-authenticated development PostgreSQL (ate-api-server's state store) and
bootstrap its roles/schema. Neither the chart nor ate-setup's public distribution creates these;
adapted from solo-io/substrate's own bundled-Postgres path -- see
\`addons/kagent/config/postgres.yaml\` and \`addons/kagent/config/postgres-setup.sql\` in this repo:

\`\`\`bash
kubectl apply --context ${ctx} -f addons/kagent/config/postgres.yaml
kubectl --context ${ctx} rollout status statefulset/postgres -n $SUBSTRATE_NAMESPACE --timeout=300s

kubectl --context ${ctx} exec -i -n $SUBSTRATE_NAMESPACE postgres-0 -c postgres -- psql \\
  --no-psqlrc --set=ON_ERROR_STOP=1 --username postgres --dbname atepg \\
  --set=substrate_schema=substrate \\
  --set=substrate_owner_role=substrate_owner --set=substrate_owner_user=substrate_owner_user --set=substrate_owner_password= \\
  --set=substrate_readwrite_role=substrate_readwrite --set=substrate_readwrite_user=substrate_readwrite_user --set=substrate_readwrite_password= \\
  < addons/kagent/config/postgres-setup.sql
\`\`\`

Create the two connection-string Secrets \`postgres.readWriteConnectionStringSecretRef\`/
\`ownerConnectionStringSecretRef\` point at, each presenting its own client cert (requires
\`postgres.clientCertificates.enabled=true\` on the substrate release below, so ate-api-server
mounts them):

\`\`\`bash
kubectl --context ${ctx} create secret generic substrate-postgres-readwrite -n $SUBSTRATE_NAMESPACE \\
  --from-literal=readWriteConnectionString="postgresql://substrate_readwrite_user@postgres.$SUBSTRATE_NAMESPACE.svc:5432/atepg?sslmode=verify-full&sslrootcert=/run/servicedns.podcert.ate.dev/trust-bundle.pem&sslcert=/run/postgres.podcert.ate.dev/substrate_readwrite_user.pem&sslkey=/run/postgres.podcert.ate.dev/substrate_readwrite_user.pem" \\
  --dry-run=client -o yaml | kubectl --context ${ctx} apply -f -
kubectl --context ${ctx} create secret generic substrate-postgres-owner -n $SUBSTRATE_NAMESPACE \\
  --from-literal=ownerConnectionString="postgresql://substrate_owner_user@postgres.$SUBSTRATE_NAMESPACE.svc:5432/atepg?sslmode=verify-full&sslrootcert=/run/servicedns.podcert.ate.dev/trust-bundle.pem&sslcert=/run/postgres.podcert.ate.dev/substrate_owner_user.pem&sslkey=/run/postgres.podcert.ate.dev/substrate_owner_user.pem" \\
  --dry-run=client -o yaml | kubectl --context ${ctx} apply -f -
\`\`\`

kagent-controller's own \`database.postgres.bundled\` feature (always enabled below) shares this
same instance rather than deploying its own. Unlike substrate's own ate-api-server (separate
servicedns/postgres volumes), kagent's chart projects everything -- client certs and the
service-dns trust bundle alike -- into one \`postgres-client-certificate\` volume at
\`/run/postgres.podcert.ate.dev\`, so \`sslrootcert\` points there too, not at substrate's own
\`/run/servicedns.podcert.ate.dev\` path (confirmed live: pointing it there makes pgx's
ParseConfig fail reading the missing file, surfacing only as "invalid PostgreSQL connection
string"). Also undocumented by Solo (confirmed live, 2026-10-31): the substrate chart's own
\`postgres\` NetworkPolicy admits only pods labeled \`app=ate-api-server\`, so a supplementary
policy is needed for kagent-controller specifically.

Bootstrap its \`kagent_owner\`/\`kagent_readwrite\` roles and \`kagent\` schema with the same generic
SQL, different variables (the controller applies its own migrations into that schema at
startup), then create its two connection-string Secrets -- note the namespace is
\`$KAGENT_NAMESPACE\`, not \`$SUBSTRATE_NAMESPACE\`, since Secrets resolve in the consuming pod's
own namespace:

\`\`\`bash
kubectl --context ${ctx} exec -i -n $SUBSTRATE_NAMESPACE postgres-0 -c postgres -- psql \\
  --no-psqlrc --set=ON_ERROR_STOP=1 --username postgres --dbname atepg \\
  --set=substrate_schema=kagent \\
  --set=substrate_owner_role=kagent_owner --set=substrate_owner_user=kagent_owner_user --set=substrate_owner_password= \\
  --set=substrate_readwrite_role=kagent_readwrite --set=substrate_readwrite_user=kagent_readwrite_user --set=substrate_readwrite_password= \\
  < addons/kagent/config/postgres-setup.sql

kubectl --context ${ctx} create secret generic kagent-postgres-readwrite -n $KAGENT_NAMESPACE \\
  --from-literal=readWriteConnectionString="postgresql://kagent_readwrite_user@postgres.$SUBSTRATE_NAMESPACE.svc:5432/atepg?sslmode=verify-full&sslrootcert=/run/postgres.podcert.ate.dev/trust-bundle.pem&sslcert=/run/postgres.podcert.ate.dev/kagent_readwrite_user.pem&sslkey=/run/postgres.podcert.ate.dev/kagent_readwrite_user.pem" \\
  --dry-run=client -o yaml | kubectl --context ${ctx} apply -f -
kubectl --context ${ctx} create secret generic kagent-postgres-owner -n $KAGENT_NAMESPACE \\
  --from-literal=ownerConnectionString="postgresql://kagent_owner_user@postgres.$SUBSTRATE_NAMESPACE.svc:5432/atepg?sslmode=verify-full&sslrootcert=/run/postgres.podcert.ate.dev/trust-bundle.pem&sslcert=/run/postgres.podcert.ate.dev/kagent_owner_user.pem&sslkey=/run/postgres.podcert.ate.dev/kagent_owner_user.pem" \\
  --dry-run=client -o yaml | kubectl --context ${ctx} apply -f -
\`\`\`

Label \`$KAGENT_NAMESPACE\` so the controller can also reach ate-api-server itself -- documented
(docs.solo.io/kagent/1.0.x/setup/installation/#install-kagent), admitted by ate-api-server's own
NetworkPolicy -- and apply the supplementary postgres NetworkPolicy mentioned above:

\`\`\`bash
kubectl --context ${ctx} label namespace $KAGENT_NAMESPACE ate.dev/api-access=true --overwrite

kubectl --context ${ctx} apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: kagent-controller-postgres-access
  namespace: $SUBSTRATE_NAMESPACE
spec:
  podSelector:
    matchLabels:
      app: postgres
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: $KAGENT_NAMESPACE
          podSelector:
            matchLabels:
              app.kubernetes.io/name: kagent-enterprise
              app.kubernetes.io/component: controller
      ports:
        - port: postgres
          protocol: TCP
EOF
\`\`\`

Install the CRDs chart next -- the main release's manifest includes CRs (e.g. the
"gvisor-default" SandboxConfig) of kinds it defines, which fail to apply if the CRDs aren't
registered yet:

\`\`\`bash
helm upgrade --install substrate-crds \\
  ${SUBSTRATE_CRDS_OCI} \\
  --namespace $SUBSTRATE_NAMESPACE \\
  --version $SUBSTRATE_VERSION \\
  --create-namespace \\
  --wait \\
  --kube-context ${ctx}
\`\`\`

Install the standalone substrate release. \`--wait=false\` is intentional -- the chart doesn't
create the cryptographic Secrets its pods need to become Ready; those come next.

\`\`\`bash
cat > substrate-values.yaml <<'EOF'
${substrateValuesLines.join('\n')}
EOF

helm upgrade --install substrate \\
  ${SUBSTRATE_OCI} \\
  --namespace $SUBSTRATE_NAMESPACE \\
  --version $SUBSTRATE_VERSION \\
  --create-namespace \\
  --wait=false \\
  -f substrate-values.yaml \\
  --kube-context ${ctx}
\`\`\`
${
  substrateIdentityAnnotation.key && substrateIdentityAnnotation.value
    ? `
Bind the atelet worker's and ate-api-server's KSAs to their cloud identity (ate-api-server needs
this too -- it manages Tags/golden snapshots directly in the bucket; without it, golden actors
suspend and snapshot fine but the Agent never reaches Ready. Neither chart ServiceAccount
template sets its own annotations, so this survives future \`helm upgrade\` runs):

\`\`\`bash
kubectl annotate serviceaccount atelet -n $SUBSTRATE_NAMESPACE \\
  ${substrateIdentityAnnotation.key}=${substrateIdentityAnnotation.value} \\
  --overwrite --context ${ctx}
kubectl annotate serviceaccount ate-api-server -n $SUBSTRATE_NAMESPACE \\
  ${substrateIdentityAnnotation.key}=${substrateIdentityAnnotation.value} \\
  --overwrite --context ${ctx}
\`\`\`
`
    : ''
}
Create the remaining 3 cryptographic pools the chart doesn't create (idempotent -- skip any that
already exist as Kubernetes Secrets; \`kubectl-ate\` was already downloaded above):

\`\`\`bash
./kubectl-ate admin make-jwt-pool --key-id=1 --name=actor-id-jwt-pool    --secret-namespace=$SUBSTRATE_NAMESPACE --context=${ctx}
./kubectl-ate admin make-ca-pool  --ca-id=1  --name=actor-id-ca-pool     --secret-namespace=$SUBSTRATE_NAMESPACE --context=${ctx}
./kubectl-ate admin make-ca-pool  --ca-id=1  --name=egress-mitm-ca-pool  --secret-namespace=$SUBSTRATE_NAMESPACE --context=${ctx} --key-type=ECDSAP256
\`\`\`

Republish the actor-id CA root as a plain PEM secret for \`ate-api-server\`:

\`\`\`bash
kubectl --context ${ctx} get secret actor-id-ca-pool -n $SUBSTRATE_NAMESPACE -o jsonpath='{.data.pool}' \\
  | base64 --decode \\
  | jq -r '.CAs[0].RootCertificateDER' \\
  | base64 --decode \\
  | openssl x509 -inform der -outform pem > actor-id-ca.crt

kubectl --context ${ctx} create secret generic actor-id-ca-certs -n $SUBSTRATE_NAMESPACE --from-file=ca.crt=actor-id-ca.crt
\`\`\`

Create the JWT authentication ConfigMap telling \`ate-api-server\` which issuer/audience to trust.
The issuer is discovered from the cluster's own OIDC discovery endpoint rather than assumed --
managed clusters (e.g. GKE) mint tokens with an external issuer, not the classic in-cluster
default, and certificateAuthorityFile/discoveryTokenFile only make sense for the latter:

\`\`\`bash
ISSUER=$(kubectl --context ${ctx} get --raw /.well-known/openid-configuration | jq -r '.issuer // "https://kubernetes.default.svc"')
if [ "$ISSUER" = "https://kubernetes.default.svc" ]; then
  IN_CLUSTER_AUTH_LINES='  certificateAuthorityFile: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
  discoveryTokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token'
else
  IN_CLUSTER_AUTH_LINES=''
fi

kubectl --context ${ctx} create configmap ate-api-authentication -n $SUBSTRATE_NAMESPACE --from-literal=authentication.yaml="jwtProviders:
- name: kubernetes
  issuer: $ISSUER
  audiences: [api.${substrateNs}.svc]
$IN_CLUSTER_AUTH_LINES
"
\`\`\`

Re-apply the same release now that the crypto pools/authentication ConfigMap exist, so pods that
were waiting on that material pick it up (\`--wait\` this time, unlike the first install above):

\`\`\`bash
helm upgrade --install substrate \\
  ${SUBSTRATE_OCI} \\
  --namespace $SUBSTRATE_NAMESPACE \\
  --version $SUBSTRATE_VERSION \\
  --create-namespace \\
  --wait \\
  -f substrate-values.yaml \\
  --kube-context ${ctx}
\`\`\`

Wait for the substrate control plane to become Ready:

\`\`\`bash
kubectl --context ${ctx} rollout status deploy/podcertificate-controller -n ${PODCERT_NAMESPACE} --timeout=300s
for d in ate-api-server ate-controller atenet-router atenet-egress k8s-credential-provider; do
  kubectl --context ${ctx} rollout status deploy/$d -n $SUBSTRATE_NAMESPACE --timeout=300s
done
kubectl --context ${ctx} rollout status ds/atelet -n $SUBSTRATE_NAMESPACE --timeout=300s
\`\`\`

`;
  }

  let oidcSecretBlock = '';
  if (oidcSecretStep) {
    oidcSecretBlock = `**Step ${oidcSecretStep} - Reconcile the kagent-enterprise-oidc-secret:**

The alpha chart's \`enterprise.oidc.secretRef\` points at this Secret rather than taking the
client secret inline.

\`\`\`bash
kubectl --context ${ctx} create secret generic kagent-enterprise-oidc-secret -n $KAGENT_NAMESPACE \\
  --from-literal=clientSecret="${clientSecret}" \\
  --dry-run=client -o yaml | kubectl --context ${ctx} apply -f -
\`\`\`

`;
  }

  let uiExposureBlock = '';
  if (uiExposureStep) {
    uiExposureBlock = `**Step ${uiExposureStep} - Create the UI's Certificate and Gateway:**

The chart's native \`ui.httpRoute.*\` values (set on the controller install below) attach an
HTTPRoute to this Gateway.

\`\`\`bash
kubectl apply --context ${ctx} -f - <<EOF
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: ${tlsSecretName}
  namespace: $KAGENT_NAMESPACE
spec:
  secretName: ${tlsSecretName}
  issuerRef:
    name: ${tlsIssuer}
    kind: ClusterIssuer
  dnsNames:
    - ${hostname}
EOF
${
  gatewaySourceRanges
    ? `
kubectl apply --context ${ctx} -f - <<EOF
apiVersion: enterpriseagentgateway.solo.io/v1alpha1
kind: EnterpriseAgentgatewayParameters
metadata:
  name: kagent-ui-https-params
  namespace: $KAGENT_NAMESPACE
spec:
  service:
    spec:
      loadBalancerSourceRanges:
${gatewaySourceRanges.map(r => `        - ${r}`).join('\n')}
EOF
`
    : ''
}
kubectl apply --context ${ctx} -f - <<EOF
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: kagent-ui-https
  namespace: $KAGENT_NAMESPACE
spec:
  gatewayClassName: ${gatewayClassName}
  listeners:
    - name: https
      port: 443
      protocol: HTTPS
      hostname: ${hostname}
      tls:
        mode: Terminate
        certificateRefs:
          - name: ${tlsSecretName}
            kind: Secret
      allowedRoutes:
        namespaces:
          from: Same
${
  gatewaySourceRanges
    ? `  infrastructure:
    parametersRef:
      name: kagent-ui-https-params
      group: enterpriseagentgateway.solo.io
      kind: EnterpriseAgentgatewayParameters
`
    : ''
}EOF
\`\`\`

kagent UI available at: **https://${hostname}**

`;
  }

  let rbacPolicyBlock = '';
  if (rbacPolicyStep) {
    const grant = (name, resource, accessLevel) =>
      `    - name: ${name}\n      resource: kagent:${resource}\n      accessLevel: ${accessLevel}`;
    const catalogManageGrants = RBAC_CATALOG_RESOURCES.map(r =>
      grant(`manage-${r}`, r, 'manage')
    ).join('\n');
    const catalogViewGrants = [
      ...RBAC_CATALOG_RESOURCES.map(r => grant(`view-${r}`, r, 'view')),
      grant('view-traces', 'traces', 'view'),
    ].join('\n');

    rbacPolicyBlock = `

**Step ${rbacPolicyStep} — Apply catalog RBAC (EnterpriseKagentRBACPolicy):**

With zero policies, every authenticated caller can view and manage every catalog resource (the
chart's own default-allow). Creating any policy flips the whole cluster to default-deny
immediately, including for admins, unless a matching policy exists -- apply the admins policy
first for that reason. Principals match the \`groups\` token claim (the chart's own default,
\`enterprise.rbac.groupsClaim\`); the keycloak addon's own group-membership mapper already emits a
claim literally named \`Groups\`, so no Helm-side override is needed.

\`\`\`bash
kubectl apply --context ${ctx} -f - <<EOF
apiVersion: kagent-enterprise.solo.io/v1alpha1
kind: EnterpriseKagentRBACPolicy
metadata:
  name: kagent-admins-manage-all
  namespace: $KAGENT_NAMESPACE
spec:
  principals:
    - all:
        - attribute: groups
          values: ["${adminsGroup}"]
  grants:
    - name: manage-all
      resource: kagent:*
      accessLevel: manage
EOF

kubectl apply --context ${ctx} -f - <<EOF
apiVersion: kagent-enterprise.solo.io/v1alpha1
kind: EnterpriseKagentRBACPolicy
metadata:
  name: kagent-writers-manage-catalog
  namespace: $KAGENT_NAMESPACE
spec:
  principals:
    - all:
        - attribute: groups
          values: ["${writersGroup}", "${agentregistryGroup}"]
  grants:
${catalogManageGrants}
EOF

kubectl apply --context ${ctx} -f - <<EOF
apiVersion: kagent-enterprise.solo.io/v1alpha1
kind: EnterpriseKagentRBACPolicy
metadata:
  name: kagent-readers-view-catalog
  namespace: $KAGENT_NAMESPACE
spec:
  principals:
    - all:
        - attribute: groups
          values: ["${readersGroup}"]
  grants:
${catalogViewGrants}
EOF
\`\`\`

Readers get \`kagent:traces\` (metadata/graphs) but never \`kagent:traces:payloads\` -- that would
expose every user's prompt/response/tool text.`;
  }

  // Order matches deploy(): controller install, then _registerClusters(), then
  // _labelGlobalServices() (the latter needs the controller Service to already exist).
  const registerClusters = Array.isArray(cfg.registerClusters) ? cfg.registerClusters : [];
  let registerBlock = '';
  if (registerClusters.length > 0) {
    const applyCmds = registerClusters
      .map(
        name => `kubectl apply --context ${ctx} -f - <<EOF
apiVersion: platform.solo.io/v1alpha1
kind: KubernetesCluster
metadata:
  name: ${name}
EOF`
      )
      .join('\n\n');
    registerBlock = `

**Step ${nextStep()}: Register clusters with the shared UI's Connected Clusters list**

\`\`\`bash
${applyCmds}
\`\`\`

Requires the solo-ui addon's management-crds already installed on ${clusterName}. This is a plain
marker object (spec: {}); it does not affect relay telemetry, which flows regardless. It only
gates whether a relay-connected cluster shows up as registered vs. unregistered in the UI.`;
  }

  const globalServices = Array.isArray(cfg.globalServices) ? cfg.globalServices : [];
  let globalServicesBlock = '';
  if (globalServices.length > 0) {
    const labelCmds = globalServices
      .map(
        svc =>
          `kubectl label service ${svc} -n $KAGENT_NAMESPACE solo.io/service-scope=global --overwrite --context ${ctx}`
      )
      .join('\n');
    globalServicesBlock = `

**Step ${nextStep()}: Mark services for cross-cluster (*.mesh.internal) visibility**

\`\`\`bash
${labelCmds}
\`\`\``;
  }

  const waypointTrustDomain = cfg.waypointTrustDomain || {};
  let waypointTrustDomainBlock = '';
  if (enterprise && waypointTrustDomain.skipValidate === true) {
    waypointTrustDomainBlock = `

**Step ${nextStep()}: Disable cross-cluster trust-domain validation on kagent waypoints**

Every kagent-created waypoint's own TrustDomainVerifier (agentgateway-enterprise) only trusts its
own cluster's trust domain by default, rejecting a cross-cluster caller's mTLS identity even though
the underlying cert chain validates fine. kagent gives no per-agent hook for this -- it's applied
cluster-wide via the shared \`enterprise-agentgateway-waypoint\` GatewayClass's own \`parametersRef\`.

\`\`\`bash
kubectl apply --context ${ctx} -f - <<EOF
apiVersion: enterpriseagentgateway.solo.io/v1alpha1
kind: EnterpriseAgentgatewayParameters
metadata:
  name: kagent-waypoint-trust-domain-params
  namespace: $KAGENT_NAMESPACE
spec:
  env:
    - name: SKIP_VALIDATE_TRUST_DOMAIN
      value: "true"
EOF

kubectl patch gatewayclass enterprise-agentgateway-waypoint --context ${ctx} --type=merge -p \\
  '{"spec":{"parametersRef":{"group":"enterpriseagentgateway.solo.io","kind":"EnterpriseAgentgatewayParameters","name":"kagent-waypoint-trust-domain-params","namespace":"$KAGENT_NAMESPACE"}}}'
\`\`\``;
  }

  return `Install kagent ${mode} on the **${clusterName}** cluster.

${ambientBlock}**Step ${crdsStep} — Install kagent CRDs:**

\`\`\`bash
${crdsCmd}
\`\`\`

${substrateBlock}${oidcSecretBlock}${uiExposureBlock}**Step ${controllerStep} — Install kagent controller:**

\`\`\`bash
${controllerCmd}
\`\`\`
${rbacPolicyBlock}${registerBlock}${globalServicesBlock}${waypointTrustDomainBlock}

Verify kagent is running:

\`\`\`bash
kubectl get pods -n $KAGENT_NAMESPACE --context ${ctx}
\`\`\``;
}

export function cleanup(addonCfg, clusterName) {
  const ns = addonCfg.namespace || 'kagent-system';
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;

  const cfg = addonCfg.config || {};
  const enterprise = cfg.enterprise === true;
  const version = addonCfg.version || (enterprise ? ENTERPRISE_VERSION : OSS_VERSION);
  const isAlphaChart = enterprise && /^1\./.test(version);
  const oidc = cfg.oidc || {};
  const hostname = cfg.hostname || null;
  const tlsSecretName = (cfg.tls || {}).secretName || 'kagent-ui-tls';
  const gatewaySourceRanges = Array.isArray(cfg.gatewaySourceRanges)
    ? cfg.gatewaySourceRanges
    : null;
  const alphaUiCleanup =
    isAlphaChart && hostname
      ? `kubectl delete gateway kagent-ui-https -n ${ns} --context ${ctx} --ignore-not-found\n` +
        `kubectl delete certificate ${tlsSecretName} -n ${ns} --context ${ctx} --ignore-not-found\n` +
        (gatewaySourceRanges
          ? `kubectl delete enterpriseagentgatewayparameters kagent-ui-https-params -n ${ns} --context ${ctx} --ignore-not-found\n`
          : '')
      : '';
  const alphaOidcCleanup =
    isAlphaChart && (oidc.issuer || oidc.keycloakHostname) && oidc.clientSecret
      ? `kubectl delete secret kagent-enterprise-oidc-secret -n ${ns} --context ${ctx} --ignore-not-found\n`
      : '';

  const registerClusters = Array.isArray(cfg.registerClusters) ? cfg.registerClusters : [];
  const registerCleanup = registerClusters
    .map(
      name =>
        `kubectl delete kubernetescluster ${name} -n ${ns} --context ${ctx} --ignore-not-found\n`
    )
    .join('');

  const waypointTrustDomain = cfg.waypointTrustDomain || {};
  const waypointTrustDomainCleanup =
    enterprise && waypointTrustDomain.skipValidate === true
      ? `kubectl patch gatewayclass enterprise-agentgateway-waypoint --context ${ctx} --type=merge -p '{"spec":{"parametersRef":null}}' || true\n` +
        `kubectl delete enterpriseagentgatewayparameters kagent-waypoint-trust-domain-params -n ${ns} --context ${ctx} --ignore-not-found\n`
      : '';

  const substrateCfg = cfg.substrate || {};
  const substrateEnabled = enterprise && substrateCfg.enabled === true;
  const substrateNs = substrateCfg.namespace || SUBSTRATE_NAMESPACE;
  const substrateCleanup = substrateEnabled
    ? `# Substrate uninstalls after kagent (controller + CRDs), matching upstream's own teardown\n` +
      `# order. GCS bucket contents (if that backend was used) are not deleted here -- cross-session\n` +
      `# data, left for manual cleanup.\n` +
      `helm uninstall substrate -n ${substrateNs} --kube-context ${ctx}\n` +
      `helm uninstall substrate-crds -n ${substrateNs} --kube-context ${ctx}\n` +
      `helm uninstall substrate-podcert -n ${PODCERT_NAMESPACE} --kube-context ${ctx}\n` +
      `kubectl delete namespace ${substrateNs} --context ${ctx} --ignore-not-found\n` +
      `kubectl delete namespace ${PODCERT_NAMESPACE} --context ${ctx} --ignore-not-found\n` +
      `rm -f substrate-values.yaml actor-id-ca.crt kubectl-ate\n`
    : '';

  return `\`\`\`bash
${waypointTrustDomainCleanup}${registerCleanup}${alphaUiCleanup}${alphaOidcCleanup}helm uninstall kagent -n ${ns} --kube-context ${ctx}
helm uninstall kagent-crds -n ${ns} --kube-context ${ctx}
${substrateCleanup}kubectl delete namespace ${ns} --context ${ctx} --ignore-not-found
\`\`\``;
}
