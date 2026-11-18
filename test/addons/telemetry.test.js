import { test, expect } from 'bun:test';
import { cleanup as telemetryRunbookCleanup } from '../../addons/telemetry/runbook.js';
import { TelemetryFeature } from '../../addons/telemetry/index.js';

test('telemetry runbook cleanup targets the cluster it was installed on (multi-cluster: gateway on east, agent on west)', () => {
  const gatewayMd = telemetryRunbookCleanup({ namespace: 'telemetry', config: {} }, 'east');
  expect(gatewayMd).toContain('helm uninstall tempo -n telemetry --kube-context $EAST_CONTEXT');
  expect(gatewayMd).toContain(
    'helm uninstall kube-prometheus-stack -n telemetry --kube-context $EAST_CONTEXT'
  );

  const agentMd = telemetryRunbookCleanup(
    { namespace: 'telemetry', config: { mode: 'agent' } },
    'west'
  );
  expect(agentMd).toContain(
    'helm uninstall opentelemetry-collector-metrics opentelemetry-collector-logs opentelemetry-collector-traces alloy -n telemetry --kube-context $WEST_CONTEXT'
  );
});

test('TelemetryFeature gatewayClassName defaults to istio', () => {
  const feature = new TelemetryFeature('telemetry', {});
  expect(feature.gatewayClassName).toBe('istio');
});

test('TelemetryFeature gatewayClassName respects an override', () => {
  const feature = new TelemetryFeature('telemetry', {
    gatewayClassName: 'enterprise-agentgateway',
  });
  expect(feature.gatewayClassName).toBe('enterprise-agentgateway');
});

test('TelemetryFeature dashboardCategories defaults to null (install every category)', () => {
  const feature = new TelemetryFeature('telemetry', {});
  expect(feature.dashboardCategories).toBeNull();
});

test('TelemetryFeature dashboardCategories respects an explicit list', () => {
  const feature = new TelemetryFeature('telemetry', { dashboardCategories: ['agw', 'substrate'] });
  expect(feature.dashboardCategories).toEqual(['agw', 'substrate']);
});

test('installDashboards auto-discovers and installs every category subdirectory by default', async () => {
  const feature = new TelemetryFeature('telemetry', { namespace: 'telemetry' });
  const applied = [];
  feature.applyResource = async resource => applied.push(resource);

  await feature.installDashboards();

  const installedNames = applied
    .filter(r => r.kind === 'ConfigMap')
    .map(r => r.metadata.name.replace('grafana-dashboard-', ''));

  // addons/telemetry/dashboards/ is fully categorized: istio/, agw/, and substrate/
  // subfolders, no loose files. The default (dashboardCategories === null) discovery
  // mode must walk every subdirectory and install all of them.
  expect(installedNames).toEqual(
    expect.arrayContaining([
      'istio-performance-dashboard',
      'istio-peering-dashboard',
      'istio-global-services-dashboard',
      'istio-ztunnel-dashboard',
      'agentgateway-overview',
      'agentgateway-performance',
      'agentgateway-cost-control',
      'agentgateway-control-plane',
      'agent-substrate-overview',
    ])
  );
  expect(installedNames.length).toBe(9);
});

test('installDashboards with an explicit dashboardCategories filter installs only that category, not others', async () => {
  const feature = new TelemetryFeature('telemetry', {
    namespace: 'telemetry',
    dashboardCategories: ['agw'],
  });
  const applied = [];
  feature.applyResource = async resource => applied.push(resource);

  await feature.installDashboards();

  // An explicit dashboardCategories filter must be both inclusive (install every
  // dashboard in the requested category) and exclusive (skip istio/ and substrate/).
  const installedNames = applied
    .filter(r => r.kind === 'ConfigMap')
    .map(r => r.metadata.name.replace('grafana-dashboard-', ''));
  expect(installedNames).toEqual(
    expect.arrayContaining([
      'agentgateway-overview',
      'agentgateway-performance',
      'agentgateway-cost-control',
      'agentgateway-control-plane',
    ])
  );
  expect(installedNames.length).toBe(4);
});
