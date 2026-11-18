// addons/otel-collector/runbook.js

const DEFAULT_CHART_VERSION = '0.158.0';

export function envVarsFor(_addonCfg, _clusterName) {
  return [];
}

export function envExportsFor(addonCfg, _profile, _env) {
  return [
    {
      name: 'OTEL_COLLECTOR_VERSION',
      value: addonCfg.version || DEFAULT_CHART_VERSION,
      comment: 'OpenTelemetry Collector chart version',
    },
  ];
}

export async function generate(_subIndex, addonCfg, clusterName, _profile, _env) {
  const addon =
    addonCfg?.config && typeof addonCfg.config === 'object'
      ? { ...addonCfg, ...addonCfg.config }
      : addonCfg;
  const namespace = addon.namespace || 'kagent';
  const clickhouseHost = addon.clickhouseHost || `kagent-clickhouse.${namespace}.svc.cluster.local`;
  const clickhousePort = addon.clickhousePort || 9000;
  const clickhouseDatabase = addon.clickhouseDatabase || 'kagent';
  // Matches the kagent-enterprise chart's own default (enterprise.database.clickhouse.*);
  // override here if that chart's password was changed from its default.
  const clickhouseUsername = addon.clickhouseUsername || 'default';
  const clickhousePassword = addon.clickhousePassword || 'password';
  // Matches the kagent-ui chart's own default (EXTENSION_LOCAL_CLUSTER_NAME);
  // override here if that chart's cluster name was changed from its default.
  const clusterNameAttr = addon.clusterName || 'mgmt-cluster';
  const telemetryNamespace = addon.telemetryNamespace || 'telemetry';
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;

  return `Install a minimal OTel Collector on the **${clusterName}** cluster to catch OTLP
traces/metrics/logs from kagent-controller and Agent Substrate (both default to
\`localhost:4317\`, which nothing listens on without this) and forward them into the
kagent-enterprise chart's own bundled ClickHouse instance, plus a fan-out copy of traces to
Tempo and metrics to Prometheus for the \`telemetry\` addon (installed separately -- see its own
runbook).

Traces/logs go through a dedicated \`clickhouse/genai\` exporter (\`json: true\`,
\`enable_json_type=1\` on the DSN) into \`otel_traces_json\`/\`otel_logs_json\` -- the exact
recipe kagent-enterprise's own management chart uses, and the only path that feeds
kagent's \`kagent_chat_spans\`/\`substrate_actor_requests\` materialized views (what the
fraud-ops-console's span source reads). \`create_schema\` stays off for that exporter to
avoid fighting the schema kagent's migrations already created. Metrics keep the original
exporter/table names, which already populate correctly as-is.

Otherwise narrower in scope than the \`telemetry\` addon: no Grafana/Loki, just enough to
unblock kagent's own dashboards (worker pool occupancy, chat spans).

Stamps a \`cluster_name\` resource attribute on every signal via \`resource/cluster_context\` --
kagent-ui's tracing page filters \`ListChatTraces\` results client-side by
\`trace.cluster === activeCluster.name\` (there is no cluster param on the request itself),
where \`activeCluster.name\` is \`EXTENSION_LOCAL_CLUSTER_NAME\` (default \`mgmt-cluster\`).
Without this attribute every trace's Cluster field is empty and never matches, so the page
shows "No Traces On This Cluster" regardless of how much real data ClickHouse has --
live-confirmed (2026-09-28) as the actual root cause of that exact empty state.

\`\`\`bash
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm repo update

cat > otel-collector-values.yaml <<'EOF'
mode: deployment
replicaCount: 1
image:
  repository: ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib
command:
  name: otelcol-contrib
config:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
        http:
          endpoint: 0.0.0.0:4318
  processors:
    batch: {}
    resource/cluster_context:
      attributes:
        - key: cluster_name
          action: insert
          value: ${clusterNameAttr}
  exporters:
    clickhouse:
      endpoint: tcp://${clickhouseUsername}:${clickhousePassword}@${clickhouseHost}:${clickhousePort}?database=${clickhouseDatabase}
      create_schema: true
      timeout: 10s
    clickhouse/genai:
      endpoint: tcp://${clickhouseUsername}:${clickhousePassword}@${clickhouseHost}:${clickhousePort}?database=${clickhouseDatabase}&dial_timeout=10s&enable_json_type=1
      json: true
      create_schema: false
      traces_table_name: otel_traces_json
      logs_table_name: otel_logs_json
      timeout: 10s
    otlp/tempo:
      endpoint: tempo-distributor.${telemetryNamespace}.svc.cluster.local:4317
      tls:
        insecure: true
    prometheus:
      endpoint: 0.0.0.0:8889
      resource_to_telemetry_conversion:
        enabled: true
  service:
    pipelines:
      traces:
        receivers: [otlp]
        processors: [resource/cluster_context, batch]
        exporters: [clickhouse/genai, otlp/tempo]
      metrics:
        receivers: [otlp]
        processors: [resource/cluster_context, batch]
        exporters: [clickhouse, prometheus]
      logs:
        receivers: [otlp]
        processors: [resource/cluster_context, batch]
        exporters: [clickhouse/genai]
ports:
  metrics:
    enabled: true
    containerPort: 8889
    servicePort: 8889
    protocol: TCP
EOF

helm upgrade --install otel-collector open-telemetry/opentelemetry-collector \\
  --kube-context ${ctx} \\
  --version $OTEL_COLLECTOR_VERSION \\
  --namespace ${namespace} \\
  --create-namespace \\
  -f otel-collector-values.yaml \\
  --wait --timeout 5m
\`\`\`

Apply a ServiceMonitor so the \`telemetry\` addon's Prometheus scrapes the collector's new
\`:8889/metrics\` endpoint (picked up automatically -- that Prometheus runs with
\`serviceMonitorSelectorNilUsesHelmValues: false\`, so it discovers ServiceMonitors in every
namespace with no extra labeling):

\`\`\`bash
kubectl apply --context ${ctx} -f - <<EOF
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: otel-collector-substrate-metrics
  namespace: ${namespace}
spec:
  selector:
    matchLabels:
      app.kubernetes.io/instance: otel-collector
  namespaceSelector:
    matchNames:
      - ${namespace}
  endpoints:
    - port: metrics
      path: /metrics
      interval: 30s
EOF
\`\`\`

Point kagent and Agent Substrate at it via each addon's own \`otel.endpoint\`
(\`otel-collector-opentelemetry-collector.${namespace}.svc.cluster.local:4317\`) -- see the
kagent addon's runbook.`;
}

export function cleanup(addonCfg, clusterName) {
  const namespace = addonCfg?.config?.namespace || addonCfg?.namespace || 'kagent';
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;
  return `\`\`\`bash
kubectl delete servicemonitor otel-collector-substrate-metrics -n ${namespace} --context ${ctx} --ignore-not-found
helm uninstall otel-collector -n ${namespace} --kube-context ${ctx}
\`\`\``;
}
