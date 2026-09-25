// addons/agentregistry/runbook.js

// tpl: return v if it's a real value (not an unresolved {{...}} template), otherwise fb
const tpl = (v, fb) => (v && !/\{\{/.test(v) ? v : fb);

const ENTERPRISE_VERSION = '2026.5.4-f1b02f7';
const ENTERPRISE_REGISTRY =
  'oci://us-docker.pkg.dev/developers-369321/agentregistry-enterprise-public-nonprod/helm';
const DEFAULT_CHART_OCI = `${ENTERPRISE_REGISTRY}/agentregistry-enterprise`;

export function envVarsFor(_addonCfg, _clusterName) {
  return [
    {
      name: 'ENTERPRISE_AGENTREGISTRY_LICENSE',
      description: 'Enterprise Agentregistry license key',
      required: true,
    },
  ];
}

export function envExportsFor(addonCfg, _profile, env) {
  const cfg = addonCfg.config || {};
  const hostname =
    tpl(cfg.hostname, env.spec.domains?.agentregistry) || 'agentregistry.example.com';
  const version = addonCfg.version || ENTERPRISE_VERSION;
  const chartOci = addonCfg.chartOci || DEFAULT_CHART_OCI;
  return [
    { name: 'AGENTREGISTRY_VERSION', value: version, comment: 'Agentregistry Enterprise version' },
    {
      name: 'AGENTREGISTRY_CHART_OCI',
      value: chartOci,
      comment: 'Agentregistry Enterprise OCI chart URL',
    },
    { name: 'AGENTREGISTRY_HOSTNAME', value: hostname, comment: 'Agentregistry public hostname' },
    {
      name: 'AGENTREGISTRY_NAMESPACE',
      value: addonCfg.namespace || 'agentregistry-system',
      comment: 'Agentregistry namespace',
    },
  ];
}

export async function generate(_subIndex, addonCfg, clusterName, _profile, env) {
  const cfg = addonCfg.config || {};
  const ns = addonCfg.namespace || 'agentregistry-system';
  const hostname =
    tpl(cfg.hostname, env.spec.domains?.agentregistry) || 'agentregistry.example.com';
  const oidc = cfg.oidc || {};
  const keycloakHostname =
    tpl(oidc.keycloakHostname, env.spec.domains?.keycloak) || 'keycloak.example.com';
  const keycloakScheme = oidc.keycloakTlsEnabled ? 'https' : 'http';
  const realm = oidc.realm || 'agentregistry';
  const oidcIssuer = `${keycloakScheme}://${keycloakHostname}/realms/${realm}`;

  // Build helm args as array to avoid blank-line continuation issues
  const helmArgs = [
    `  $AGENTREGISTRY_CHART_OCI`,
    `  --namespace ${ns}`,
    `  --create-namespace`,
    `  --version $AGENTREGISTRY_VERSION`,
    `  --set-string licensing.licenseKey="$ENTERPRISE_AGENTREGISTRY_LICENSE"`,
    `  --set service.type=LoadBalancer`,
    `  --set-string "service.annotations.external-dns\\.alpha\\.kubernetes\\.io/hostname=${hostname}"`,
    ...(oidc.clientId
      ? [
          `  --set oidc.issuer="${oidcIssuer}"`,
          `  --set oidc.clientId="${oidc.clientId || 'ar-backend'}"`,
          `  --set-string oidc.clientSecret="${oidc.clientSecret || 'ar-backend-secret'}"`,
          `  --set oidc.publicClientId="${oidc.publicClientId || 'ar-ui'}"`,
          `  --set oidc.roleClaim="${oidc.roleClaim || 'Groups'}"`,
          `  --set oidc.superuserRole="${oidc.superuserRole || 'admins'}"`,
        ]
      : []),
    `  --wait`,
    `  --timeout 10m`,
  ];
  const helmCmd = `helm upgrade --install agentregistry \\\n${helmArgs
    .map(a => `${a} \\`)
    .join('\n')
    .replace(/ \\$/, '')}`;

  const ambientBlock = cfg.ambient
    ? `

Required for this cluster to reach a *.mesh.internal cross-cluster hostname at all (e.g.
registering a remote kagent Runtime) -- outside the ambient mesh that hostname suffix doesn't
resolve:

\`\`\`bash
kubectl create namespace ${ns} --dry-run=client -o yaml | kubectl apply -f -
kubectl label namespace ${ns} istio.io/dataplane-mode=ambient --overwrite
\`\`\``
    : '';

  return `Install Solo Enterprise Agentregistry on the **${clusterName}** cluster.
${ambientBlock}

\`\`\`bash
${helmCmd}
\`\`\`

Verify Agentregistry is accessible:

\`\`\`bash
curl -s https://${hostname}/health | jq .
\`\`\``;
}

export function cleanup(addonCfg, _clusterName) {
  const ns = addonCfg.namespace || 'agentregistry-system';
  return `\`\`\`bash
helm uninstall agentregistry -n ${ns}
\`\`\``;
}
