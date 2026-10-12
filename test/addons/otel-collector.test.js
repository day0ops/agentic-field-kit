import { test, expect } from 'bun:test';
import { generate as otelCollectorRunbookGenerate } from '../../addons/otel-collector/runbook.js';

test('otel-collector runbook routes traces/logs through the json-mode genai exporter, metrics through the plain one', async () => {
  const md = await otelCollectorRunbookGenerate(1, { config: {} }, 'east', {}, { spec: {} });
  expect(md).toContain('clickhouse/genai:');
  expect(md).toContain('json: true');
  expect(md).toContain('traces_table_name: otel_traces_json');
  expect(md).toContain('logs_table_name: otel_logs_json');
  expect(md).toContain('enable_json_type=1');
  expect(md).toContain('exporters: [clickhouse/genai]');
  expect(md).toMatch(
    /traces:\s*\n\s*receivers: \[otlp\]\s*\n\s*processors: \[resource\/cluster_context, batch\]\s*\n\s*exporters: \[clickhouse\/genai\]/
  );
  expect(md).toMatch(
    /metrics:\s*\n\s*receivers: \[otlp\]\s*\n\s*processors: \[resource\/cluster_context, batch\]\s*\n\s*exporters: \[clickhouse\]\n/
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
