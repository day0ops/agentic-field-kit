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
const SUBSTRATE_VERSION = '0.2.0-beta6-5462374';
const SUBSTRATE_OCI = 'oci://us-docker.pkg.dev/solo-public/enterprise-substrate-helm/substrate';
const SUBSTRATE_WORKER_IMAGE_REGISTRY = 'us-docker.pkg.dev/solo-public/substrate-enterprise';
const SUBSTRATE_NAMESPACE = 'ate-system';
const PODCERT_NAMESPACE = 'podcertificate-controller-system';
const KUBECTL_ATE_VERSION = 'v0.2.0-beta5';

// Keep in sync with addons/kagent/index.js's ANNOTATION_KEY_TO_STORAGE_BACKEND.
const ANNOTATION_KEY_TO_STORAGE_BACKEND = {
  'iam.gke.io/gcp-service-account': 'gcs',
  'eks.amazonaws.com/role-arn': 's3',
};

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

  // Alpha chart line (1.0.0-alpha3+) moved OIDC to enterprise.oidc.*/enterprise.rbac.roleMappings.*
  // and registers a separate frontend client -- mirrors addons/kagent/index.js's isAlphaChart gate.
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
      `${SUBSTRATE_WORKER_IMAGE_REGISTRY}/ateom-gvisor:v${substrateVersionForImage}`,
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
      // Guard against a missing Groups claim -- client_credentials tokens from service
      // accounts may not carry Groups until added to a group in the IdP; without the guard
      // CEL evaluates a missing claim as a runtime error, i.e. a 401 (commas escaped -- Helm's
      // --set parser splits unescaped commas as separate assignments).
      `  --set-string "enterprise.rbac.roleMapper=has(claims.Groups) ? claims.Groups.transformList(i\\, v\\, v in rolesMap\\, rolesMap[v]) : []"`,
      `  --set enterprise.oidc.issuer="${oidcIssuer}"`,
      `  --set enterprise.oidc.clientId="${clientId}"`,
      `  --set enterprise.oidc.secretRef=kagent-enterprise-oidc-secret`,
      `  --set enterprise.oidc.secretKey=clientSecret`,
      `  --set "enterprise.rbac.roleMappings.${adminsGroup}=global.Admin"`,
      `  --set "enterprise.rbac.roleMappings.${writersGroup}=global.Writer"`,
      `  --set "enterprise.rbac.roleMappings.${readersGroup}=global.Reader"`,
      `  --set enterprise.ui.frontend.oidc.clientId="${uiClientId}"`
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

  let substrateBlock = '';
  if (substrateEnabled) {
    const substrateValuesLines = [
      // atenet-egress/atenet-router run agentgateway-enterprise -- a different product from
      // kagent-enterprise, with its own license (confirmed live: kagent's own license is
      // rejected with "license does not cover the required product").
      'global:',
      '  licensing:',
      '    licenseKey: "$ENTERPRISE_AGENTGATEWAY_LICENSE"',
      'credentialProvider:',
      '  namespacePolicies:',
      '    - atespace: $KAGENT_NAMESPACE',
      '      allowedNamespaces: [$KAGENT_NAMESPACE]',
    ];
    if (otlpEndpoint) {
      substrateValuesLines.push(
        'otel:',
        `  endpoint: "${otlpEndpoint}"`,
        '  traces:',
        '    enabled: false'
      );
    }
    if (substrateSnapshotBackend === 'gcs') {
      substrateValuesLines.push('atelet:', '  storageBackend: gcs', '  gcpAuthForImagePulls: true');
    }

    substrateBlock = `**Step ${substrateStep} - Install Agent Substrate:**

Agent Substrate is the sandboxed actor/worker runtime kagent runs agents in (gVisor by default).
Requires a Kubernetes cluster serving \`certificates.k8s.io/v1beta1\` with \`PodCertificateRequest\`
enabled (GKE 1.37+ on the RAPID channel; EKS cannot enable this on its managed control plane).

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
Download \`kubectl-ate\`, the CLI used to bootstrap substrate's cryptographic pools:

\`\`\`bash
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
curl -fsSL -o kubectl-ate \\
  "https://github.com/kagent-dev/substrate/releases/download/$KUBECTL_ATE_VERSION/kubectl-ate-\${OS}-\${ARCH}" &&
  chmod +x kubectl-ate
\`\`\`

Create the five cryptographic pools the chart doesn't create (idempotent -- skip any that already
exist as Kubernetes Secrets):

\`\`\`bash
./kubectl-ate admin make-ca-pool  --ca-id=1  --name=service-dns-ca-pool  --secret-namespace=${PODCERT_NAMESPACE} --context=${ctx}
./kubectl-ate admin make-ca-pool  --ca-id=1  --name=pod-identity-ca-pool --secret-namespace=${PODCERT_NAMESPACE} --context=${ctx}
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

kubectl --context ${ctx} create configmap ate-api-authentication -n $SUBSTRATE_NAMESPACE --from-literal=authentication.yaml="actorIdentityJWTProvider: kubernetes
jwtProviders:
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
${registerBlock}${globalServicesBlock}${waypointTrustDomainBlock}

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
