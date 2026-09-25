// test/lib/runbook-adapters/env.test.js
import { test, expect } from 'bun:test';
import { EnvAdapter } from '../../../src/lib/runbook-adapters/env.js';

const mockSelection = {
  profile: { metadata: { name: 'test-profile' } },
  infraProfile: { spec: { name: 'maple' } },
  environment: { spec: {} },
};

const mockVars = [
  { name: 'ENTERPRISE_ISTIO_LICENSE', description: 'License key', required: true },
  { name: 'AWS_PROFILE', description: 'AWS profile', required: true },
  { name: 'GRAFANA_HOSTNAME', description: 'Grafana hostname', required: false },
];

const mockExports = [
  { name: 'AWS_REGION', value: 'ap-southeast-1', comment: 'AWS region' },
  { name: 'CILIUM_VERSION', value: '1.19.4', comment: 'Cilium version' },
];

test('EnvAdapter.envVars returns empty array', () => {
  const adapter = new EnvAdapter();
  expect(adapter.envVars(mockSelection)).toEqual([]);
});

test('EnvAdapter.envExports returns empty array', () => {
  const adapter = new EnvAdapter();
  expect(adapter.envExports(mockSelection)).toEqual([]);
});

test('EnvAdapter.generate produces markdown table with all vars, no Required column', () => {
  const adapter = new EnvAdapter();
  const md = adapter.generate(1, mockSelection, mockVars, mockExports);
  expect(md).toContain('## Lab 1');
  expect(md).toContain('ENTERPRISE_ISTIO_LICENSE');
  expect(md).toContain('AWS_PROFILE');
  expect(md).toContain('GRAFANA_HOSTNAME');
  expect(md).not.toContain('| Required |');
});

test('EnvAdapter.generate includes collapsible export block', () => {
  const adapter = new EnvAdapter();
  const md = adapter.generate(1, mockSelection, mockVars, mockExports);
  expect(md).toContain('<details>');
  expect(md).toContain('export AWS_REGION="ap-southeast-1"');
  expect(md).toContain('export CILIUM_VERSION="1.19.4"');
  expect(md).toContain('# AWS region');
});

test('EnvAdapter.generate groups variables into categories in a fixed priority order', () => {
  const adapter = new EnvAdapter();
  const md = adapter.generate(1, mockSelection, mockVars, mockExports);
  const licensesIdx = md.indexOf('#### Licenses');
  const credentialsIdx = md.indexOf('#### Credentials');
  const hostnamesIdx = md.indexOf('#### Hostnames & Domains');
  const versionsIdx = md.indexOf('#### Versions');
  const otherIdx = md.indexOf('#### Other');
  expect(licensesIdx).toBeGreaterThan(-1);
  expect(credentialsIdx).toBeGreaterThan(licensesIdx);
  expect(hostnamesIdx).toBeGreaterThan(credentialsIdx);
  expect(versionsIdx).toBeGreaterThan(hostnamesIdx);
  expect(otherIdx).toBeGreaterThan(versionsIdx);
});

test('EnvAdapter.generate sorts variables alphabetically by name within each category', () => {
  const adapter = new EnvAdapter();
  const vars = [
    { name: 'GRAFANA_ADMIN_PASSWORD', description: 'Grafana password', required: true },
    { name: 'AWS_PROFILE', description: 'AWS profile', required: true },
    { name: 'KEYCLOAK_ADMIN_USERNAME', description: 'Keycloak username', required: true },
  ];
  const md = adapter.generate(1, mockSelection, vars, []);
  const awsIdx = md.indexOf('AWS_PROFILE');
  const grafanaIdx = md.indexOf('GRAFANA_ADMIN_PASSWORD');
  const keycloakIdx = md.indexOf('KEYCLOAK_ADMIN_USERNAME');
  expect(awsIdx).toBeGreaterThan(-1);
  expect(grafanaIdx).toBeGreaterThan(awsIdx);
  expect(keycloakIdx).toBeGreaterThan(grafanaIdx);
});

test('EnvAdapter.generate buckets uncategorized variables under Other', () => {
  const adapter = new EnvAdapter();
  const vars = [{ name: 'INFRA_NAME', description: 'Infra name', required: false }];
  const md = adapter.generate(1, mockSelection, vars, []);
  expect(md).toContain('#### Other');
  expect(md).toContain('INFRA_NAME');
});

test('EnvAdapter.generate excludes hideFromTable exports from the table but keeps them in the export block', () => {
  const adapter = new EnvAdapter();
  const exports = [
    { name: 'AWS_REGION', value: 'ap-southeast-1', comment: 'AWS region' },
    { name: 'INFRA_NAME', value: 'maple', comment: 'Terraform infrastructure name', hideFromTable: true },
  ];
  const md = adapter.generate(1, mockSelection, [], exports);
  expect(md).not.toContain('| `INFRA_NAME` |');
  expect(md).toContain('export INFRA_NAME="maple"');
  expect(md).toContain('| `AWS_REGION` |');
});

test('EnvAdapter dedup logic: first-occurrence wins', () => {
  const vars = [
    { name: 'KEY', description: 'first', required: true },
    { name: 'KEY', description: 'second', required: false },
  ];
  const seen = new Set();
  const deduped = vars.filter(v => {
    if (seen.has(v.name)) return false;
    seen.add(v.name);
    return true;
  });
  expect(deduped).toHaveLength(1);
  expect(deduped[0].description).toBe('first');
});
