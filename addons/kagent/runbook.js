// addons/kagent/runbook.js

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

export function envVarsFor(addonCfg, _clusterName) {
  const enterprise = (addonCfg.config || {}).enterprise === true;
  const vars = [
    { name: 'OPENAI_API_KEY', description: 'OpenAI API key for LLM provider', required: false },
  ];
  if (enterprise) {
    vars.unshift({
      name: 'ENTERPRISE_KAGENT_LICENSE',
      description: 'Solo Enterprise for kagent license key',
      required: true,
    });
  }
  return vars;
}

export function envExportsFor(addonCfg, _profile, _env) {
  const enterprise = (addonCfg.config || {}).enterprise === true;
  const version = addonCfg.version || (enterprise ? ENTERPRISE_VERSION : OSS_VERSION);
  return [
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
}

export async function generate(_subIndex, addonCfg, clusterName, _profile, env) {
  const cfg = addonCfg.config || {};
  const enterprise = cfg.enterprise === true;
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;

  const oidc = cfg.oidc || {};
  const keycloakHostname =
    tpl(oidc.keycloakHostname, env.spec.domains?.keycloak) || 'keycloak.example.com';
  const keycloakScheme = oidc.keycloakTlsEnabled ? 'https' : 'http';
  const realm = oidc.realm || 'kagent';
  const oidcIssuer = oidc.issuer || `${keycloakScheme}://${keycloakHostname}/realms/${realm}`;
  const clientId = oidc.clientId || (enterprise ? 'kagent-backend' : 'kagent');
  const clientSecret = oidc.clientSecret || '';

  const provider = cfg.provider || {};
  const providerType = provider.type || 'openAI';
  const otel = cfg.otel || {};
  let otlpEndpoint =
    tpl(otel.endpoint, null) || 'opentelemetry-collector-traces.telemetry.svc.cluster.local:4317';
  if (!/^https?:\/\//.test(otlpEndpoint)) {
    otlpEndpoint = `http://${otlpEndpoint}`;
  }

  const database = cfg.database || {};
  const storageClass = database.storageClass || 'gp3';

  const rbac = cfg.rbac || {};
  const adminsGroup = rbac.adminsGroup || 'kagent-admins';
  const writersGroup = rbac.writersGroup || 'kagent-writers';
  const readersGroup = rbac.readersGroup || 'kagent-readers';

  const crdsOci = enterprise ? ENT_CRDS_OCI : OSS_CRDS_OCI;
  const controllerOci = enterprise ? ENT_CONTROLLER_OCI : OSS_CONTROLLER_OCI;
  const mode = enterprise ? 'Enterprise' : 'OSS';

  const crdsCmd = `helm upgrade --install kagent-crds \\
  ${crdsOci} \\
  --namespace $KAGENT_NAMESPACE \\
  --version $KAGENT_VERSION \\
  --wait \\
  --kube-context ${ctx}`;

  // Controller helm args
  const controllerArgs = [
    `  ${controllerOci}`,
    `  --namespace $KAGENT_NAMESPACE`,
    `  --version $KAGENT_VERSION`,
  ];

  if (enterprise) {
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
    `  --set otel.tracing.enabled=true`,
    `  --set otel.tracing.exporter.otlp.endpoint="${otlpEndpoint}"`,
    `  --set otel.tracing.exporter.otlp.insecure=true`,
    `  --set database.postgres.bundled.storageClassName=${storageClass}`,
    `  --wait`,
    `  --timeout 10m`,
    `  --kube-context ${ctx}`
  );

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
  const controllerStep = nextStep();

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

**Step ${controllerStep} — Install kagent controller:**

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

  return `\`\`\`bash
${waypointTrustDomainCleanup}${registerCleanup}helm uninstall kagent -n ${ns} --kube-context ${ctx}
helm uninstall kagent-crds -n ${ns} --kube-context ${ctx}
kubectl delete namespace ${ns} --context ${ctx} --ignore-not-found
\`\`\``;
}
