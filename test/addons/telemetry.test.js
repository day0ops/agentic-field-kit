import { test, expect } from 'bun:test';
import { cleanup as telemetryRunbookCleanup } from '../../addons/telemetry/runbook.js';

test('telemetry runbook cleanup targets the cluster it was installed on (multi-cluster: gateway on east, agent on west)', () => {
  const gatewayMd = telemetryRunbookCleanup({ namespace: 'telemetry', config: {} }, 'east');
  expect(gatewayMd).toContain('helm uninstall tempo -n telemetry --kube-context $EAST_CONTEXT');
  expect(gatewayMd).toContain('helm uninstall kube-prometheus-stack -n telemetry --kube-context $EAST_CONTEXT');

  const agentMd = telemetryRunbookCleanup({ namespace: 'telemetry', config: { mode: 'agent' } }, 'west');
  expect(agentMd).toContain(
    'helm uninstall opentelemetry-collector-metrics opentelemetry-collector-logs opentelemetry-collector-traces alloy -n telemetry --kube-context $WEST_CONTEXT'
  );
});
