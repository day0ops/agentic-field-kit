// Default Helm chart versions for the telemetry stack
// Ref: https://docs.solo.io/gloo-mesh/main/setup/observability/prometheus/
// Ref: https://docs.solo.io/gloo-mesh/main/setup/observability/grafana/
export const DEFAULT_CHART_VERSIONS = {
  'kube-prom-stack': '86.1.0',
  loki: '7.0.0',
  tempo: '1.61.3',
  alloy: '1.8.2',
  otel: '0.158.0',
};

/**
 * Resolve effective Helm chart versions from addon config.
 * @param {{ version?: string, chartVersions?: object }} config - Flattened addon config (index.js)
 *   or { version, chartVersions } derived from profile addon entry (runbook.js)
 */
export function resolveChartVersions({ version, chartVersions } = {}) {
  const overrides = chartVersions || {};
  return {
    'kube-prom-stack':
      overrides['kube-prom-stack'] ||
      overrides.prometheus ||
      DEFAULT_CHART_VERSIONS['kube-prom-stack'],
    loki: overrides.loki || DEFAULT_CHART_VERSIONS.loki,
    tempo: overrides.tempo || DEFAULT_CHART_VERSIONS.tempo,
    alloy: overrides.alloy || DEFAULT_CHART_VERSIONS.alloy,
    otel: version || overrides.otel || DEFAULT_CHART_VERSIONS.otel,
  };
}
