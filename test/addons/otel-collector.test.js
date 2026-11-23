import { test, expect } from 'bun:test';
import { generate as otelCollectorRunbookGenerate } from '../../addons/otel-collector/runbook.js';
import { OtelCollectorFeature } from '../../addons/otel-collector/index.js';

test('otel-collector runbook routes traces/logs through the json-mode genai exporter, metrics through the plain one', async () => {
  const md = await otelCollectorRunbookGenerate(1, { config: {} }, 'east', {}, { spec: {} });
  expect(md).toContain('clickhouse/genai:');
  expect(md).toContain('json: true');
  expect(md).toContain('traces_table_name: otel_traces_json');
  expect(md).toContain('logs_table_name: otel_logs_json');
  expect(md).toContain('enable_json_type=1');
  expect(md).toContain('exporters: [clickhouse/genai]');
  expect(md).toMatch(
    /traces:\s*\n\s*receivers: \[otlp\]\s*\n\s*processors: \[resource\/cluster_context, batch\]\s*\n\s*exporters: \[clickhouse\/genai, otlp\/tempo\]/
  );
  expect(md).toMatch(
    /metrics:\s*\n\s*receivers: \[otlp\]\s*\n\s*processors: \[resource\/cluster_context, batch\]\s*\n\s*exporters: \[clickhouse, prometheus\]\n/
  );
});

test('otel-collector runbook stamps a cluster_name resource attribute matching kagent-ui default', async () => {
  const md = await otelCollectorRunbookGenerate(1, { config: {} }, 'east', {}, { spec: {} });
  expect(md).toContain('resource/cluster_context:');
  expect(md).toMatch(/key: cluster_name\s*\n\s*action: insert\s*\n\s*value: mgmt-cluster/);
});

test('otel-collector runbook respects a custom clusterName override', async () => {
  const md = await otelCollectorRunbookGenerate(
    1,
    { config: { clusterName: 'east-cluster' } },
    'east',
    {},
    { spec: {} }
  );
  expect(md).toMatch(/key: cluster_name\s*\n\s*action: insert\s*\n\s*value: east-cluster/);
});

test('OtelCollectorFeature tempoEndpoint defaults to the telemetry namespace', () => {
  const feature = new OtelCollectorFeature('otel-collector', {});
  expect(feature.tempoEndpoint).toBe('tempo-distributor.telemetry.svc.cluster.local:4317');
});

test('OtelCollectorFeature tempoEndpoint respects a custom telemetryNamespace', () => {
  const feature = new OtelCollectorFeature('otel-collector', { telemetryNamespace: 'obs' });
  expect(feature.tempoEndpoint).toBe('tempo-distributor.obs.svc.cluster.local:4317');
});

test('OtelCollectorFeature buildValues adds Tempo and Prometheus exporters alongside the existing ClickHouse ones', () => {
  const feature = new OtelCollectorFeature('otel-collector', {});
  const values = feature.buildValues();

  expect(values.config.exporters['otlp/tempo']).toEqual({
    endpoint: 'tempo-distributor.telemetry.svc.cluster.local:4317',
    tls: { insecure: true },
  });
  expect(values.config.exporters.prometheus).toEqual({
    endpoint: '0.0.0.0:8889',
    resource_to_telemetry_conversion: { enabled: true },
  });
  // Existing ClickHouse exporters must survive untouched.
  expect(values.config.exporters.clickhouse.create_schema).toBe(true);
  expect(values.config.exporters['clickhouse/genai'].traces_table_name).toBe('otel_traces_json');

  expect(values.config.service.pipelines.traces.exporters).toEqual([
    'clickhouse/genai',
    'otlp/tempo',
  ]);
  expect(values.config.service.pipelines.metrics.exporters).toEqual(['clickhouse', 'prometheus']);
  // Logs pipeline is untouched - no Tempo/Prometheus involvement.
  expect(values.config.service.pipelines.logs.exporters).toEqual(['clickhouse/genai']);

  expect(values.ports.metrics).toEqual({
    enabled: true,
    containerPort: 8889,
    servicePort: 8889,
    protocol: 'TCP',
  });
});

test('otel-collector runbook documents the Tempo and Prometheus exporters', async () => {
  const md = await otelCollectorRunbookGenerate(1, { config: {} }, 'east', {}, { spec: {} });
  expect(md).toContain('otlp/tempo:');
  expect(md).toContain('endpoint: tempo-distributor.telemetry.svc.cluster.local:4317');
  expect(md).toContain('prometheus:');
  expect(md).toContain('endpoint: 0.0.0.0:8889');
  expect(md).toMatch(/exporters: \[clickhouse\/genai, otlp\/tempo\]/);
  expect(md).toMatch(/exporters: \[clickhouse, prometheus\]/);
  expect(md).toContain('ServiceMonitor');
  expect(md).toContain('otel-collector-substrate-metrics');
});

// ── ClickHouse credential resolution (reads the kagent addon's generated Secret) ────

test('OtelCollectorFeature defaults clickhouseUsername/Password to null (resolved at deploy time)', () => {
  const feature = new OtelCollectorFeature('otel-collector', {});
  expect(feature.clickhouseUsername).toBeNull();
  expect(feature.clickhousePassword).toBeNull();
});

test('OtelCollectorFeature respects explicit clickhouseUsername/Password overrides', () => {
  const feature = new OtelCollectorFeature('otel-collector', {
    clickhouseUsername: 'custom',
    clickhousePassword: 'custom-pass',
  });
  expect(feature.clickhouseUsername).toBe('custom');
  expect(feature.clickhousePassword).toBe('custom-pass');
});

test('buildValues falls back to the chart default when no credential has been resolved', () => {
  const feature = new OtelCollectorFeature('otel-collector', {});
  const values = feature.buildValues();
  expect(values.config.exporters.clickhouse.endpoint).toContain('tcp://default:password@');
});

test('buildValues uses a resolved/explicit credential once set', () => {
  const feature = new OtelCollectorFeature('otel-collector', {
    clickhouseUsername: 'default',
    clickhousePassword: 's3cr3t',
  });
  const values = feature.buildValues();
  expect(values.config.exporters.clickhouse.endpoint).toContain('tcp://default:s3cr3t@');
});

test('_decodeSecretPair decodes a "b64|b64" jsonpath result', () => {
  const feature = new OtelCollectorFeature('otel-collector', {});
  const encoded = `${Buffer.from('default').toString('base64')}|${Buffer.from('s3cr3t').toString('base64')}`;
  expect(feature._decodeSecretPair(encoded)).toEqual(['default', 's3cr3t']);
});

test('_decodeSecretPair returns null for empty or malformed content', () => {
  const feature = new OtelCollectorFeature('otel-collector', {});
  expect(feature._decodeSecretPair('')).toBeNull();
  expect(feature._decodeSecretPair('no-pipe-here')).toBeNull();
});
