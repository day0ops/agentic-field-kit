import { test, expect } from 'bun:test';
import { generate as ciliumRunbookGenerate, cleanup as ciliumRunbookCleanup } from '../../addons/cilium/runbook.js';

test('cilium runbook generate targets the cluster it is installed on', async () => {
  const md = await ciliumRunbookGenerate(1, { version: '1.19.4' }, 'east', {}, { spec: {} });
  expect(md).toContain('--kube-context $EAST_CONTEXT');
});

test('cilium runbook generate disables cilium-envoy (not needed — L7 is handled by Istio Ambient waypoints)', async () => {
  const md = await ciliumRunbookGenerate(1, { version: '1.19.4' }, 'east', {}, { spec: {} });
  expect(md).toContain('--set envoy.enabled=false');
});

test('cilium runbook cleanup targets the cluster it is installed on', () => {
  const md = ciliumRunbookCleanup({}, 'west');
  expect(md).toContain('helm uninstall cilium -n kube-system --kube-context $WEST_CONTEXT');
});
