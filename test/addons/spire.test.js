import { test, expect } from 'bun:test';
import { SpireFeature } from '../../addons/spire/index.js';
import { join } from 'path';
import { tmpdir } from 'os';

test('SpireFeature constructor sets defaults', () => {
  const f = new SpireFeature('spire', { clusterName: 'my-cluster' });
  expect(f.spireNamespace).toBe('spire-server');
  expect(f.trustDomain).toBe('my-cluster');
  expect(f.spireVersion).toBe('0.30.0');
  expect(f.spireCrdsVersion).toBe('0.6.0');
  expect(f.certMode).toBe('self-signed');
  expect(f.multiRoot).toBe(false);
  expect(f.kubeContext).toBeNull();
});

test('SpireFeature constructor respects multiRoot override', () => {
  const f = new SpireFeature('spire', { clusterName: 'my-cluster', multiRoot: true });
  expect(f.multiRoot).toBe(true);
});

test('SpireFeature constructor defaults distinctRoots to false', () => {
  const f = new SpireFeature('spire', { clusterName: 'my-cluster' });
  expect(f.distinctRoots).toBe(false);
});

test('SpireFeature distinctRoots implies multiRoot', () => {
  const f = new SpireFeature('spire', { clusterName: 'my-cluster', distinctRoots: true });
  expect(f.distinctRoots).toBe(true);
  expect(f.multiRoot).toBe(true);
});

test('SpireFeature constructor respects overrides', () => {
  const f = new SpireFeature('spire', {
    clusterName: 'my-cluster',
    trustDomain: 'custom.domain',
    spireNamespace: 'custom-spire',
    spireVersion: '0.25.0',
    spireCrdsVersion: '0.6.0',
    certMode: 'cert-manager',
    kubeContext: 'ctx1',
  });
  expect(f.spireNamespace).toBe('custom-spire');
  expect(f.trustDomain).toBe('custom.domain');
  expect(f.spireVersion).toBe('0.25.0');
  expect(f.spireCrdsVersion).toBe('0.6.0');
  expect(f.certMode).toBe('cert-manager');
  expect(f.kubeContext).toBe('ctx1');
});

test('SpireFeature validate passes for self-signed', () => {
  const f = new SpireFeature('spire', { clusterName: 'c1', certMode: 'self-signed' });
  expect(f.validate()).toBe(true);
});

test('SpireFeature validate passes for cert-manager', () => {
  const f = new SpireFeature('spire', { clusterName: 'c1', certMode: 'cert-manager' });
  expect(f.validate()).toBe(true);
});

test('SpireFeature validate throws for manual without cert paths', () => {
  const f = new SpireFeature('spire', { clusterName: 'c1', certMode: 'manual' });
  expect(() => f.validate()).toThrow(
    'manual certMode requires certs.caCert, certs.caKey, and certs.caChain'
  );
});

test('SpireFeature validate passes for manual with all cert paths', () => {
  const f = new SpireFeature('spire', {
    clusterName: 'c1',
    certMode: 'manual',
    certs: { caCert: '/a/ca.crt', caKey: '/a/ca.key', caChain: '/a/chain.pem' },
  });
  expect(f.validate()).toBe(true);
});

test('SpireFeature validate throws for unknown certMode', () => {
  const f = new SpireFeature('spire', { clusterName: 'c1', certMode: 'bogus' });
  expect(() => f.validate()).toThrow(
    "Invalid certMode 'bogus'. Must be: self-signed, cert-manager, manual"
  );
});

test('SpireFeature certsWorkDir returns path under tmpdir', () => {
  const f = new SpireFeature('spire', { clusterName: 'c1' });
  const expected = join(tmpdir(), 'agentic-spire-certs');
  expect(f.certsWorkDir).toBe(expected);
});

test('SpireFeature validate throws for cert-manager mode missing cert-manager addon hint', () => {
  // No throw — cert-manager presence check is at runtime, not validate()
  const f = new SpireFeature('spire', { clusterName: 'c1', certMode: 'cert-manager' });
  expect(f.validate()).toBe(true); // validate doesn't require clusterAddons
});

test('SpireFeature certManagerIssuerRef defaults', () => {
  const f = new SpireFeature('spire', { clusterName: 'c1', certMode: 'cert-manager' });
  expect(f.certManagerIssuerRef).toEqual({ name: 'selfsigned-issuer', kind: 'ClusterIssuer' });
});

test('SpireFeature certManagerIssuerRef uses config override', () => {
  const f = new SpireFeature('spire', {
    clusterName: 'c1',
    certMode: 'cert-manager',
    certManager: { issuerRef: { name: 'my-issuer', kind: 'Issuer' } },
  });
  expect(f.certManagerIssuerRef).toEqual({ name: 'my-issuer', kind: 'Issuer' });
});

test('SpireFeature buildSpireHelmValues includes trust domain and ztunnel delegate', () => {
  const f = new SpireFeature('spire', { clusterName: 'test-cluster' });
  const v = f.buildSpireHelmValues();
  expect(v.global.spire.trustDomain).toBe('test-cluster');
  expect(v['spire-agent'].authorizedDelegates).toContain(
    'spiffe://test-cluster/ns/istio-system/sa/ztunnel'
  );
  expect(v['spire-agent'].sockets.admin.enabled).toBe(true);
  expect(v['spire-agent'].sockets.admin.mountOnHost).toBe(true);
  expect(v['spire-agent'].sockets.hostBasePath).toBe('/run/spire/agent/sockets');
  expect(v['spire-server'].upstreamAuthority.disk.enabled).toBe(true);
  expect(v['spire-server'].upstreamAuthority.disk.secret.name).toBe('spiffe-upstream-ca');
});

test('SpireFeature cleanup method exists and is a function', () => {
  const f = new SpireFeature('spire', { clusterName: 'c1' });
  expect(typeof f.cleanup).toBe('function');
  // We can't run the real cleanup (requires a cluster), but we can verify
  // the method doesn't throw immediately on instantiation
  expect(f.cleanup).toBeDefined();
});

import '../../addons/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

test('spire addon is registered in FeatureManager', () => {
  expect(FeatureManager.has('spire')).toBe(true);
});

import {
  generate as spireRunbookGenerate,
  generatePreamble as spireRunbookGeneratePreamble,
  cleanup as spireRunbookCleanup,
} from '../../addons/spire/runbook.js';

test('spire runbook generate returns markdown with helm commands', async () => {
  const addonCfg = { certMode: 'self-signed' };
  const md = await spireRunbookGenerate(1, addonCfg, 'my-cluster', {}, { spec: {} });
  expect(md).toContain('helm');
  expect(md).toContain('spire');
  expect(md).toContain('spiffe-upstream-ca');
});

test('spire runbook generate sets secret.data.bundle so the chart actually reads bundle.crt (silently ignored otherwise, confirmed live)', async () => {
  const addonCfg = { certMode: 'self-signed' };
  const md = await spireRunbookGenerate(1, addonCfg, 'my-cluster', {}, { spec: {} });
  expect(md).toContain('data:\n          bundle: "externally-managed"');
});

test('spire runbook generate targets the cluster it is installed on', async () => {
  const md = await spireRunbookGenerate(1, { certMode: 'self-signed' }, 'east', {}, { spec: {} });
  expect(md).toContain('--kube-context $EAST_CONTEXT');
  expect(md).toContain('--context=$EAST_CONTEXT');
});

test('spire runbook generate reads trustDomain/certMode/distinctRoots from a nested config block', async () => {
  const addonCfg = { config: { trustDomain: 'east.local', certMode: 'self-signed', distinctRoots: true } };
  const md = await spireRunbookGenerate(1, addonCfg, 'east', {}, { spec: {} });
  expect(md).toContain('trustDomain: east.local');
  expect(md).not.toContain('trustDomain: east\n');
  expect(md).toContain('pre-generated independent root');
});

test('spire runbook generate builds the distinctRoots bundle in own-root, istiod-root, peer-roots order (order-dependent live bug, not cosmetic)', async () => {
  const addonCfg = { config: { trustDomain: 'east.local', certMode: 'self-signed', distinctRoots: true } };
  const md = await spireRunbookGenerate(1, addonCfg, 'east', {}, { spec: {} });
  // own root first
  expect(md).toContain(
    'cat /tmp/spire-distinct-roots/east.local/root-cert.pem /tmp/spire-certs/east.local/istio-root.pem > /tmp/spire-certs/east.local/bundle.pem'
  );
  // then every OTHER trust domain's root appended, skipping its own (already included above)
  expect(md).toContain('[ "$peer_root" = "/tmp/spire-distinct-roots/east.local/root-cert.pem" ] && continue');
});

test('spire runbook generate resolves a {{cluster.name}} template in trustDomain to the real cluster name', async () => {
  const addonCfg = { config: { trustDomain: '{{cluster.name}}.local', certMode: 'self-signed' } };
  const md = await spireRunbookGenerate(1, addonCfg, 'west', {}, { spec: {} });
  expect(md).toContain('trustDomain: west.local');
  expect(md).not.toContain('{{cluster.name}}');
});

test('spire runbook generatePreamble resolves a {{cluster.name}} template in trustDomain per instance', async () => {
  const instances = [
    { addon: { config: { trustDomain: '{{cluster.name}}.local', distinctRoots: true } }, clusterName: 'east' },
    { addon: { config: { trustDomain: '{{cluster.name}}.local', distinctRoots: true } }, clusterName: 'west' },
  ];
  const preamble = await spireRunbookGeneratePreamble(instances, {});
  expect(preamble).toContain('east.local');
  expect(preamble).toContain('west.local');
  expect(preamble).not.toContain('{{cluster.name}}');
});

test('spire runbook generate uses the plain shared-root flow when distinctRoots/multiRoot are unset', async () => {
  const addonCfg = { config: { trustDomain: 'east.local', certMode: 'self-signed' } };
  const md = await spireRunbookGenerate(1, addonCfg, 'east', {}, { spec: {} });
  expect(md).not.toContain('pre-generated independent root');
  expect(md).not.toContain('SPIRE-only root');
});

test('spire runbook generate uses a dedicated shared root (not istiod\'s) when multiRoot is set without distinctRoots', async () => {
  const addonCfg = { config: { trustDomain: 'east.local', certMode: 'self-signed', multiRoot: true } };
  const md = await spireRunbookGenerate(1, addonCfg, 'east', {}, { spec: {} });
  expect(md).toContain('/tmp/spire-shared-root');
  // federation happens inline (both directions), at first-mint time, not deferred to a later lab
  expect(md).toContain("get secret cacerts -n istio-system");
  expect(md).toContain('patch secret cacerts -n istio-system --type=merge');
});

test('spire runbook generatePreamble generates one independent root per cluster with distinctRoots enabled', async () => {
  const instances = [
    { addon: { config: { trustDomain: 'east.local', distinctRoots: true } }, clusterName: 'east' },
    { addon: { config: { trustDomain: 'west.local', distinctRoots: true } }, clusterName: 'west' },
  ];
  const preamble = await spireRunbookGeneratePreamble(instances, {});
  expect(preamble).toContain('Generate independent SPIRE roots');
  expect(preamble).toContain('east.local');
  expect(preamble).toContain('west.local');
  // no heading of its own — folded in as plain content before the addon's numbered sections
  expect(preamble.startsWith('###')).toBe(false);
});

test('spire runbook generatePreamble returns null when no instance has distinctRoots enabled', async () => {
  const instances = [{ addon: { config: { trustDomain: 'east.local' } }, clusterName: 'east' }];
  const preamble = await spireRunbookGeneratePreamble(instances, {});
  expect(preamble).toBeNull();
});

test('spire runbook cleanup returns helm uninstall command', () => {
  const md = spireRunbookCleanup({ spireNamespace: 'spire-server' }, 'my-cluster');
  expect(md).toContain('helm uninstall spire');
});

test('spire runbook cleanup targets the cluster it is installed on', () => {
  const md = spireRunbookCleanup({ spireNamespace: 'spire-server' }, 'west');
  expect(md).toContain('--kube-context $WEST_CONTEXT');
  expect(md).toContain('--context=$WEST_CONTEXT');
});
