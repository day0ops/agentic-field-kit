// addons/telemetry/runbook.js
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { resolveChartVersions } from './versions.js';
import { resolveRunbookTemplates } from '../../src/lib/runbook-adapters/template-vars.js';

const __dir = dirname(fileURLToPath(import.meta.url));

// tpl: return v if it's a real value (not an unresolved {{...}} template), otherwise fb
const tpl = (v, fb) => (v && !/\{\{/.test(v) ? v : fb);

function readConfig(name) {
  return fs.promises.readFile(join(__dir, 'config', name), 'utf8');
}

function chartVersionsFromAddon(addonCfg) {
  return resolveChartVersions({
    version: addonCfg.version,
    chartVersions: addonCfg.chartVersions || addonCfg.config?.chartVersions,
  });
}

export function envVarsFor(addonCfg, _clusterName) {
  const cfg = addonCfg.config || {};
  if (cfg.mode === 'agent') return [];
  return [
    { name: 'GRAFANA_ADMIN_USERNAME', description: 'Grafana admin login username', required: true },
    { name: 'GRAFANA_ADMIN_PASSWORD', description: 'Grafana admin login password', required: true },
  ];
}

export function envExportsFor(addonCfg, _profile, env) {
  const cfg = addonCfg.config || {};
  const versions = chartVersionsFromAddon(addonCfg);
  const exports = [
    {
      name: 'OTEL_CHART_VERSION',
      value: versions.otel,
      comment: 'OpenTelemetry collector Helm chart version',
    },
    {
      name: 'TELEMETRY_ALLOY_VERSION',
      value: versions.alloy,
      comment: 'Grafana Alloy Helm chart version',
    },
  ];
  if (cfg.mode !== 'agent') {
    const grafanaHostname =
      tpl(cfg.grafanaHostname, env.spec.domains?.core?.grafana) || 'grafana.example.com';
    exports.unshift(
      { name: 'GRAFANA_HOSTNAME', value: grafanaHostname, comment: 'Grafana public hostname' },
      {
        name: 'TELEMETRY_NAMESPACE',
        value: addonCfg.namespace || 'telemetry',
        comment: 'Telemetry stack namespace',
      },
      {
        name: 'PROMETHEUS_STACK_VERSION',
        value: versions['kube-prom-stack'],
        comment: 'kube-prometheus-stack Helm chart version',
      },
      { name: 'LOKI_VERSION', value: versions.loki, comment: 'Grafana Loki Helm chart version' },
      { name: 'TEMPO_VERSION', value: versions.tempo, comment: 'Grafana Tempo Helm chart version' }
    );
  }
  return exports;
}

export async function generate(_subIndex, addonCfg, clusterName, _profile, env) {
  const cfg = addonCfg.config || {};
  if (cfg.mode === 'agent') {
    return _generateAgent(addonCfg, clusterName, env);
  }
  return _generateGateway(addonCfg, clusterName, env);
}

async function _generateGateway(addonCfg, clusterName, env) {
  const [
    tempoValues,
    lokiValues,
    alloyValues,
    prometheusValues,
    metricsValuesRaw,
    logsValuesRaw,
    tracesValuesRaw,
    gatewayValuesRaw,
    datasourcesYamlRaw,
  ] = await Promise.all([
    readConfig('tempo-values.yaml'),
    readConfig('loki-values.yaml'),
    readConfig('alloy-values.yaml'),
    readConfig('prometheus-values.yaml'),
    readConfig('otel-metrics-values.yaml'),
    readConfig('otel-logs-values.yaml'),
    readConfig('otel-traces-values.yaml'),
    readConfig('otel-gateway-values.yaml'),
    readConfig('grafana-datasources.yaml'),
  ]);

  const cfg = addonCfg.config || {};
  const ns = addonCfg.namespace || 'telemetry';
  const soloUiNs = cfg.soloUiNamespace || 'solo-enterprise';
  const agentregistryNs = cfg.agentregistryNamespace || 'agentregistry-system';
  // Mirrors index.js: storageClass/storageSize are nested under config.database.
  const storageClass = cfg.database?.storageClass || cfg.storageClass || 'gp3';
  const storageSize = cfg.database?.storageSize || cfg.storageSize || '50Gi';
  const retention = cfg.retention || '120h';
  const grafanaHostname =
    tpl(cfg.grafanaHostname, env.spec.domains?.core?.grafana) || 'grafana.example.com';
  // Safe to reference the shell variable anywhere this is interpolated into an
  // unquoted heredoc or plain/double-quoted argument; the Grafana OIDC values block
  // below uses a *quoted* heredoc (`<<'EOF'`) so it must keep the literal instead.
  const grafanaHostnameRef = tpl(cfg.grafanaHostname, null) || '$GRAFANA_HOSTNAME';
  const grafanaTls = cfg.grafanaTls || {};
  const grafanaOidc = cfg.grafanaOidc || {};
  const globalExport = cfg.globalExport === true;

  const tlsIssuer = grafanaTls.issuer || 'letsencrypt-dns';
  const tlsSecret = grafanaTls.secretName || 'grafana-tls';

  // Substitute {{...}} template vars in OTel values files before embedding
  const fillGateway = s =>
    s
      .replaceAll('{{TELEMETRY_NAMESPACE}}', ns)
      .replaceAll('{{SOLO_UI_NAMESPACE}}', soloUiNs)
      .replaceAll('{{AGENTREGISTRY_NAMESPACE}}', agentregistryNs)
      .replaceAll('{{CLUSTER_NAME}}', clusterName);

  const metricsValues = fillGateway(metricsValuesRaw);
  const logsValues = fillGateway(logsValuesRaw);
  const tracesValues = fillGateway(tracesValuesRaw);
  const gatewayValues = fillGateway(gatewayValuesRaw);
  const datasourcesYaml = fillGateway(datasourcesYamlRaw);

  // Indent datasources YAML for embedding inside ConfigMap data block
  const datasourcesIndented = datasourcesYaml
    .trimEnd()
    .split('\n')
    .map(l => `    ${l}`)
    .join('\n');

  let grafanaTlsSection = '';
  if (grafanaTls?.enabled && grafanaHostname) {
    grafanaTlsSection = `

Apply Grafana TLS resources (cert-manager Certificate, Gateway API Gateway, HTTPRoute):

\`\`\`bash
# TLS Certificate
kubectl apply -f - <<EOF
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: grafana-tls
  namespace: ${ns}
spec:
  secretName: ${tlsSecret}
  issuerRef:
    name: ${tlsIssuer}
    kind: ClusterIssuer
  dnsNames:
    - ${grafanaHostnameRef}
EOF

# Gateway
kubectl apply -f - <<EOF
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: grafana
  namespace: ${ns}
spec:
  gatewayClassName: istio
  listeners:
    - name: https
      port: 443
      protocol: HTTPS
      hostname: ${grafanaHostnameRef}
      tls:
        mode: Terminate
        certificateRefs:
          - group: ""
            name: ${tlsSecret}
            kind: Secret
      allowedRoutes:
        namespaces:
          from: All
EOF

# HTTPRoute
kubectl apply -f - <<EOF
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: grafana
  namespace: ${ns}
spec:
  parentRefs:
    - name: grafana
      namespace: ${ns}
  hostnames:
    - ${grafanaHostnameRef}
  rules:
    - backendRefs:
        - name: kube-prometheus-stack-grafana
          port: 80
      matches:
        - path:
            type: PathPrefix
            value: /
EOF
\`\`\``;
  }

  // Grafana OIDC values block — appended as additional -f block on kube-prometheus-stack
  let grafanaOidcValuesBlock = '';
  let grafanaOidcNote = '';
  if (grafanaOidc?.enabled) {
    const realm =
      (grafanaOidc.issuerUrl?.split('/realms/')[1] || 'grafana')
        .replace(/\{\{[^}]+\}\}/g, '')
        .replace(/^\//, '') || 'grafana';
    const issuerUrl = resolveRunbookTemplates(grafanaOidc.issuerUrl, { env }) || '';
    const clientId = grafanaOidc.clientId || 'grafana';
    const clientSecret = grafanaOidc.clientSecret || 'grafana-client-secret';
    const adminGroup = grafanaOidc.adminGroup || 'grafana-admins';
    const roleAttrPath = `contains(Groups[*], '${adminGroup}') && 'Admin' || 'Viewer'`;

    grafanaOidcValuesBlock = `

Apply Grafana OIDC configuration (separate upgrade to avoid overwriting base values):

\`\`\`bash
helm upgrade kube-prometheus-stack prometheus-community/kube-prometheus-stack \\
  --namespace ${ns} \\
  --reuse-values \\
  -f - <<EOF
# Grafana OIDC (Keycloak generic_oauth)
grafana:
  assertNoLeakedSecrets: false
  grafana.ini:
    server:
      root_url: https://${grafanaHostnameRef}
    auth:
      disable_login_form: true
      oauth_auto_login: true
    auth.generic_oauth:
      enabled: true
      name: Keycloak
      allow_sign_up: true
      client_id: ${clientId}
      client_secret: ${clientSecret}
      scopes: openid email profile offline_access
      auth_url: ${issuerUrl}/protocol/openid-connect/auth
      token_url: ${issuerUrl}/protocol/openid-connect/token
      api_url: ${issuerUrl}/protocol/openid-connect/userinfo
      role_attribute_path: "${roleAttrPath}"
      use_pkce: true
EOF
\`\`\``;

    grafanaOidcNote = `
> **OIDC:** Grafana is configured with Keycloak OIDC (realm \`${realm}\`, client \`${clientId}\`). The login form is disabled — authenticate via Keycloak only.
`;
  }

  const globalExportSection = globalExport
    ? `

Label OTel gateway as a global service so agent clusters can reach it over the ambient mesh:

\`\`\`bash
kubectl label svc opentelemetry-collector-gateway -n ${ns} solo.io/service-scope=global --overwrite
\`\`\``
    : '';

  return `Install telemetry stack (Tempo, Loki, Alloy, Prometheus, Grafana, OTel collectors) on the **${clusterName}** cluster in gateway mode.

\`\`\`bash
helm repo add grafana https://grafana.github.io/helm-charts
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
\`\`\`

Label namespace for Ambient mesh (required for cross-cluster mesh.internal DNS):

\`\`\`bash
kubectl create namespace ${ns} --dry-run=client -o yaml | kubectl apply -f -
kubectl label namespace ${ns} istio.io/dataplane-mode=ambient --overwrite
\`\`\`

Install Grafana Tempo Distributed (trace aggregation, OTLP receiver):

\`\`\`bash
helm upgrade --install tempo grafana/tempo-distributed \\
  --namespace ${ns} \\
  --version $TEMPO_VERSION \\
  --set ingester.persistence.enabled=true \\
  --set ingester.persistence.storageClass=${storageClass} \\
  --set ingester.persistence.size=${storageSize} \\
  --set compactor.persistence.enabled=true \\
  --set compactor.persistence.storageClass=${storageClass} \\
  --set compactor.persistence.size=${storageSize} \\
  --create-namespace \\
  --wait \\
  -f - <<'EOF'
${tempoValues.trimEnd()}
EOF
\`\`\`

Install Grafana Loki (log aggregation):

\`\`\`bash
helm upgrade --install loki grafana/loki \\
  --namespace ${ns} \\
  --version $LOKI_VERSION \\
  --set loki.limits_config.retention_period=${retention} \\
  --set loki.limits_config.reject_old_samples_max_age=${retention} \\
  --set minio.storageClass=${storageClass} \\
  --set minio.persistence.size=${storageSize} \\
  --set singleBinary.persistence.storageClass=${storageClass} \\
  --set singleBinary.persistence.size=${storageSize} \\
  --create-namespace \\
  --wait \\
  -f - <<'EOF'
${lokiValues.trimEnd()}
EOF
\`\`\`

Install Grafana Alloy (pod log scraping DaemonSet):

\`\`\`bash
helm upgrade --install alloy grafana/alloy \\
  --namespace ${ns} \\
  --version $TELEMETRY_ALLOY_VERSION \\
  --create-namespace \\
  --wait \\
  -f - <<'EOF'
${alloyValues.trimEnd()}
EOF
\`\`\`

Install Prometheus + Grafana (kube-prometheus-stack):

\`\`\`bash
helm upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack \\
  --namespace ${ns} \\
  --version $PROMETHEUS_STACK_VERSION \\
  --set prometheus.prometheusSpec.retention=${retention} \\
  --set-string grafana.adminUser=$GRAFANA_ADMIN_USERNAME \\
  --set-string grafana.adminPassword=$GRAFANA_ADMIN_PASSWORD \\
  --set-string "grafana.sidecar.datasources.reloadURL=http://$GRAFANA_ADMIN_USERNAME:$GRAFANA_ADMIN_PASSWORD@localhost:3000/api/admin/provisioning/datasources/reload" \\
  --set prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.storageClassName=${storageClass} \\
  --set prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.resources.requests.storage=${storageSize} \\
  --set "grafana.service.annotations.external-dns\\.alpha\\.kubernetes\\.io/hostname=${grafanaHostnameRef}" \\
  --create-namespace \\
  --wait \\
  --timeout 10m \\
  -f - <<'EOF'
${prometheusValues.trimEnd()}
EOF
\`\`\`
${grafanaOidcValuesBlock}${grafanaOidcNote}
Install OTel collectors (metrics, logs, traces) — receives telemetry from the local Istio mesh:

\`\`\`bash
# Metrics collector (scrapes istiod, ztunnel, gateways)
helm upgrade --install opentelemetry-collector-metrics opentelemetry-collector \\
  --repo https://open-telemetry.github.io/opentelemetry-helm-charts \\
  --version $OTEL_CHART_VERSION \\
  --namespace ${ns} \\
  --set mode=deployment \\
  --set image.repository=otel/opentelemetry-collector-contrib \\
  --set command.name=otelcol-contrib \\
  --create-namespace \\
  -f - <<'EOF'
${metricsValues.trimEnd()}
EOF

# Logs collector (receives OTLP logs from gateways)
helm upgrade --install opentelemetry-collector-logs opentelemetry-collector \\
  --repo https://open-telemetry.github.io/opentelemetry-helm-charts \\
  --version $OTEL_CHART_VERSION \\
  --namespace ${ns} \\
  --set mode=deployment \\
  --set image.repository=otel/opentelemetry-collector-contrib \\
  --set command.name=otelcol-contrib \\
  -f - <<'EOF'
${logsValues.trimEnd()}
EOF

# Traces collector (OTLP receiver, forwards to Tempo)
helm upgrade --install opentelemetry-collector-traces opentelemetry-collector \\
  --repo https://open-telemetry.github.io/opentelemetry-helm-charts \\
  --version $OTEL_CHART_VERSION \\
  --namespace ${ns} \\
  --set mode=deployment \\
  --set image.repository=otel/opentelemetry-collector-contrib \\
  --set command.name=otelcol-contrib \\
  -f - <<'EOF'
${tracesValues.trimEnd()}
EOF
\`\`\`

Install OTel gateway collector (cross-cluster fan-in from agent clusters):

\`\`\`bash
helm upgrade --install opentelemetry-collector-gateway opentelemetry-collector \\
  --repo https://open-telemetry.github.io/opentelemetry-helm-charts \\
  --version $OTEL_CHART_VERSION \\
  --namespace ${ns} \\
  --set mode=deployment \\
  --set image.repository=otel/opentelemetry-collector-contrib \\
  --set command.name=otelcol-contrib \\
  -f - <<'EOF'
${gatewayValues.trimEnd()}
EOF
\`\`\`
${grafanaTlsSection}

Apply Grafana datasources (Prometheus, Tempo, Loki):

\`\`\`bash
kubectl apply -n ${ns} -f - <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-datasources
  namespace: ${ns}
  labels:
    grafana_datasource: "1"
    app.kubernetes.io/managed-by: agentic-demo
data:
  datasources.yaml: |
${datasourcesIndented}
EOF
\`\`\`
${globalExportSection}`;
}

async function _generateAgent(addonCfg, clusterName, env) {
  const [metricsValuesRaw, logsValuesRaw, tracesValuesRaw, alloyValuesRaw] = await Promise.all([
    readConfig('otel-metrics-agent-values.yaml'),
    readConfig('otel-logs-agent-values.yaml'),
    readConfig('otel-traces-agent-values.yaml'),
    readConfig('alloy-agent-values.yaml'),
  ]);

  const cfg = addonCfg.config || {};
  const ns = addonCfg.namespace || 'telemetry';
  // Resolves any {{env.internal.*}} template to the real cross-cluster mesh.internal DNS
  // name (there's no dedicated env var for these — they're derived, not user-configured).
  const otelEndpoint =
    resolveRunbookTemplates(cfg.otelGatewayEndpoint, { env }) ||
    'opentelemetry-collector-gateway.telemetry.mesh.internal:4317';
  const lokiPushUrl =
    resolveRunbookTemplates(cfg.lokiPushUrl, { env }) ||
    'http://loki.telemetry.mesh.internal:3100/loki/api/v1/push';

  // Substitute {{...}} template vars in agent OTel values files before embedding
  const fillAgent = s =>
    s
      .replaceAll('{{CLUSTER_NAME}}', clusterName)
      .replaceAll('{{OTEL_GATEWAY_ENDPOINT}}', otelEndpoint)
      .replaceAll('{{LOKI_PUSH_URL}}', lokiPushUrl);

  const metricsValues = fillAgent(metricsValuesRaw);
  const logsValues = fillAgent(logsValuesRaw);
  const tracesValues = fillAgent(tracesValuesRaw);
  const alloyValues = fillAgent(alloyValuesRaw);

  return `Install telemetry agent on the **${clusterName}** cluster. Forwards all signals (metrics, logs, traces) to the east cluster OTel gateway via ambient mesh \`mesh.internal\` DNS. Pod logs forwarded to east Loki via Alloy.

Label namespace for Ambient mesh (required for cross-cluster \`mesh.internal\` DNS resolution):

\`\`\`bash
kubectl create namespace ${ns} --dry-run=client -o yaml | kubectl apply -f -
kubectl label namespace ${ns} istio.io/dataplane-mode=ambient --overwrite
\`\`\`

\`\`\`bash
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update
\`\`\`

Install OTel collectors (metrics, logs, traces) — forward all signals to east gateway at \`${otelEndpoint}\`:

\`\`\`bash
# Metrics collector
helm upgrade --install opentelemetry-collector-metrics opentelemetry-collector \\
  --repo https://open-telemetry.github.io/opentelemetry-helm-charts \\
  --version $OTEL_CHART_VERSION \\
  --namespace ${ns} \\
  --set mode=deployment \\
  --set image.repository=otel/opentelemetry-collector-contrib \\
  --set command.name=otelcol-contrib \\
  --create-namespace \\
  -f - <<'EOF'
${metricsValues.trimEnd()}
EOF

# Logs collector
helm upgrade --install opentelemetry-collector-logs opentelemetry-collector \\
  --repo https://open-telemetry.github.io/opentelemetry-helm-charts \\
  --version $OTEL_CHART_VERSION \\
  --namespace ${ns} \\
  --set mode=deployment \\
  --set image.repository=otel/opentelemetry-collector-contrib \\
  --set command.name=otelcol-contrib \\
  -f - <<'EOF'
${logsValues.trimEnd()}
EOF

# Traces collector
helm upgrade --install opentelemetry-collector-traces opentelemetry-collector \\
  --repo https://open-telemetry.github.io/opentelemetry-helm-charts \\
  --version $OTEL_CHART_VERSION \\
  --namespace ${ns} \\
  --set mode=deployment \\
  --set image.repository=otel/opentelemetry-collector-contrib \\
  --set command.name=otelcol-contrib \\
  -f - <<'EOF'
${tracesValues.trimEnd()}
EOF
\`\`\`

Install Grafana Alloy (DaemonSet — scrapes pod logs, forwards to east Loki at \`${lokiPushUrl}\`):

\`\`\`bash
helm upgrade --install alloy grafana/alloy \\
  --namespace ${ns} \\
  --version $TELEMETRY_ALLOY_VERSION \\
  --create-namespace \\
  --wait \\
  -f - <<'EOF'
${alloyValues.trimEnd()}
EOF
\`\`\`

> Connectivity depends on the east-west ambient mesh being operational. Verify \`mesh.internal\` DNS resolves before deploying.`;
}

export function cleanup(addonCfg, clusterName) {
  const ns = addonCfg.namespace || 'telemetry';
  const cfg = addonCfg.config || {};
  const ctx = `--kube-context $${clusterName.toUpperCase()}_CONTEXT`;
  if (cfg.mode === 'agent') {
    return `\`\`\`bash
helm uninstall opentelemetry-collector-metrics opentelemetry-collector-logs opentelemetry-collector-traces alloy -n ${ns} ${ctx}
\`\`\``;
  }
  return `\`\`\`bash
helm uninstall opentelemetry-collector-gateway opentelemetry-collector-traces opentelemetry-collector-logs opentelemetry-collector-metrics -n ${ns} ${ctx}
helm uninstall kube-prometheus-stack -n ${ns} ${ctx}
helm uninstall alloy -n ${ns} ${ctx}
helm uninstall loki -n ${ns} ${ctx}
helm uninstall tempo -n ${ns} ${ctx}
\`\`\``;
}
