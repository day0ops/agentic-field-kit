// test/lib/runbook-adapters/install.test.js
import { test, expect } from 'bun:test';
import { InstallAdapter } from '../../../src/lib/runbook-adapters/install.js';

const singleClusterSelection = {
  infraProfile: {
    spec: {
      name: 'maple',
      provider: 'eks',
      clusters: [{ name: 'east' }],
    },
  },
  profile: {
    metadata: { name: 'test-profile' },
    spec: {
      mesh: {
        istioVersion: '1.30.0',
        gatewayApiVersion: 'v1.4.0',
        profile: 'ambient',
        image: {
          tag: '1.30.0-solo',
          istioRepo: 'us-docker.pkg.dev/soloio-img/istio',
          helmIstioRepo: 'us-docker.pkg.dev/soloio-img/istio-helm',
        },
        components: [
          { name: 'base', values: { defaultRevision: '' } },
          {
            name: 'istiod',
            values: { global: { multiCluster: { clusterName: '{{cluster.name}}' } } },
          },
          { name: 'cni', values: { ambient: { dnsCapture: true } } },
          { name: 'ztunnel', values: { multiCluster: { clusterName: '{{cluster.name}}' } } },
        ],
      },
    },
  },
};

const multiClusterSelection = {
  infraProfile: {
    spec: {
      name: 'maple',
      provider: 'eks',
      clusters: [{ name: 'east' }, { name: 'west' }],
    },
  },
  profile: {
    metadata: { name: 'test-profile' },
    spec: {
      mesh: {
        istioVersion: '1.30.0',
        gatewayApiVersion: 'v1.4.0',
        profile: 'ambient',
        peering: 'helm',
        certificates: { mode: 'self-signed' },
        image: {
          tag: '1.30.0-solo',
          istioRepo: 'us-docker.pkg.dev/soloio-img/istio',
          helmIstioRepo: 'us-docker.pkg.dev/soloio-img/istio-helm',
        },
        components: [
          { name: 'base', values: {} },
          {
            name: 'istiod',
            values: { global: { multiCluster: { clusterName: '{{cluster.name}}' } } },
          },
          { name: 'cni', values: {} },
          { name: 'ztunnel', values: { multiCluster: { clusterName: '{{cluster.name}}' } } },
          { name: 'peering-eastwest', values: { eastwest: { cluster: '{{cluster.name}}' } } },
          { name: 'peering-remote', values: { trustDomain: '{{cluster.name}}.local' } },
        ],
      },
    },
  },
};

test('InstallAdapter.generate produces Lab 3 heading', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generate(4, singleClusterSelection);
  expect(md).toContain('## Lab 4');
  expect(md).toContain('Istio Ambient');
});

test('InstallAdapter.generate includes Gateway API CRDs install', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generate(4, singleClusterSelection);
  expect(md).toContain('gateway-api/releases/download/v1.4.0/standard-install.yaml');
  expect(md).toContain('Gateway API CRDs');
});

test('InstallAdapter.generate applies Gateway API CRDs on every cluster, not just the current context (CRDs are cluster-scoped)', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generate(4, multiClusterSelection);
  expect(md).toContain('kubectl --context=$EAST_CONTEXT apply -f https://github.com/kubernetes-sigs/gateway-api');
  expect(md).toContain('kubectl --context=$WEST_CONTEXT apply -f https://github.com/kubernetes-sigs/gateway-api');
});

test('InstallAdapter.generate includes helm install commands for all non-deferred components', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generate(4, singleClusterSelection);
  expect(md).toContain('istio-base');
  expect(md).toContain('istiod');
  expect(md).toContain('istio-cni');
  expect(md).toContain('ztunnel');
  // peering-remote is deferred — should not appear
  expect(md).not.toContain('peering-remote');
});

test('InstallAdapter.generate uses OCI helm repo from profile', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generate(4, singleClusterSelection);
  expect(md).toContain('oci://us-docker.pkg.dev/soloio-img/istio-helm');
  expect(md).toContain('1.30.0-solo');
});

test('InstallAdapter.generate passes ENTERPRISE_ISTIO_LICENSE via a --set-string flag, not inside the quoted values heredoc', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generate(4, singleClusterSelection);
  expect(md).toContain('--set-string license.value=$ENTERPRISE_ISTIO_LICENSE');
  // The values heredoc is quoted (<<'EOF'), so a $VAR reference embedded in it would never
  // expand — it must not appear inside the YAML values block itself.
  expect(md).not.toContain('license:\n    value: "$ENTERPRISE_ISTIO_LICENSE"');
  expect(md).not.toMatch(/value: \$ENTERPRISE_ISTIO_LICENSE\n/);
});

test('InstallAdapter.generate resolves {{cluster.name}} templates', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generate(4, singleClusterSelection);
  // Template variable should be resolved to actual cluster name
  expect(md).not.toContain('{{cluster.name}}');
  expect(md).toContain('east');
});

test('InstallAdapter.generate labels namespace with network topology', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generate(4, singleClusterSelection);
  expect(md).toContain('topology.istio.io/network=east');
});

test('InstallAdapter.generate installs on both clusters in multicluster', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generate(4, multiClusterSelection);
  expect(md).toContain('### Install on `east`');
  expect(md).toContain('### Install on `west`');
});

test('InstallAdapter.generate includes cluster linking for multicluster', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generate(4, multiClusterSelection);
  // helm peering method — should show peering-remote install
  expect(md).toContain('Link Clusters');
  expect(md).toContain('peering-remote');
});

test("InstallAdapter.generate discovers each cluster's real east-west gateway address and passes it as the peer's address (peering-remote can't federate without it)", () => {
  const adapter = new InstallAdapter();
  const md = adapter.generate(4, multiClusterSelection);
  // Discovery commands, one per cluster
  expect(md).toContain(
    'export EAST_EW_ADDRESS=$(kubectl --context=$EAST_CONTEXT get svc istio-eastwest -n istio-eastwest'
  );
  expect(md).toContain(
    'export WEST_EW_ADDRESS=$(kubectl --context=$WEST_CONTEXT get svc istio-eastwest -n istio-eastwest'
  );
  // east's peering-remote values reference west's discovered address, and vice versa
  expect(md).toContain('address: $WEST_EW_ADDRESS');
  expect(md).toContain('address: $EAST_EW_ADDRESS');
  // trust domain identifies the PEER cluster, not the one being configured
  expect(md).toContain('cluster: west');
  expect(md).toContain('trustDomain: west.local');
  expect(md).toContain('cluster: east');
  expect(md).toContain('trustDomain: east.local');
  // values heredoc must be unquoted for the $VAR address reference to actually expand
  expect(md).toContain('-f - <<EOF');
  expect(md).not.toContain("-f - <<'EOF'\nremote:");
});

test('InstallAdapter.generate no longer includes cert setup or SPIRE federation (moved to Cluster Bootstrap / the addon itself)', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generate(4, multiClusterSelection);
  expect(md).not.toContain('Set Up Shared Root of Trust');
  expect(md).not.toContain('Federate SPIRE Trust into Istiod cacerts');
});

test('InstallAdapter.generateCertSetup includes cert setup for multicluster', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generateCertSetup(5, multiClusterSelection);
  expect(md).toContain('## Lab 5 — Cluster Bootstrap');
  expect(md).toContain('Root CA');
  expect(md).toContain('cacerts');
  expect(md).toContain('Intermediate CA');
});

test('InstallAdapter.generateCertSetup returns empty for a single-cluster profile with no extra sections', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generateCertSetup(5, singleClusterSelection);
  expect(md).toBe('');
});

test('InstallAdapter.generateCertSetup appends extra sections (e.g. SPIRE root pre-generation) after cert setup', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generateCertSetup(5, multiClusterSelection, ['### Generate Independent SPIRE Roots\n\nfoo']);
  expect(md).toContain('Set Up Shared Root of Trust');
  expect(md).toContain('### Generate Independent SPIRE Roots');
  expect(md.indexOf('Set Up Shared Root of Trust')).toBeLessThan(
    md.indexOf('### Generate Independent SPIRE Roots')
  );
});

test('InstallAdapter.generateCertSetup returns only the extra sections for a single-cluster profile (no cacerts step)', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generateCertSetup(5, singleClusterSelection, ['### Generate Independent SPIRE Roots\n\nfoo']);
  expect(md).toContain('## Lab 5 — Cluster Bootstrap');
  expect(md).toContain('### Generate Independent SPIRE Roots');
  expect(md).not.toContain('Set Up Shared Root of Trust');
});

test('InstallAdapter envVars returns empty array', () => {
  const adapter = new InstallAdapter();
  expect(adapter.envVars(singleClusterSelection)).toEqual([]);
});

test('InstallAdapter envExports returns ISTIO_VERSION', () => {
  const adapter = new InstallAdapter();
  const exports = adapter.envExports(singleClusterSelection);
  expect(exports).toEqual([
    { name: 'ISTIO_VERSION', value: '1.30.0-solo', comment: 'Istio Ambient Helm chart version' },
  ]);
});

test('InstallAdapter.generate references $ISTIO_VERSION in the --version flag, not the literal tag', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generate(4, singleClusterSelection);
  expect(md).toContain('--version $ISTIO_VERSION');
});

test('InstallAdapter.generateCleanupSections uninstalls components per cluster with a heading', () => {
  const adapter = new InstallAdapter();
  const sections = adapter.generateCleanupSections(8, singleClusterSelection, 3);
  expect(sections).toHaveLength(1);
  const md = sections[0];
  expect(md).toContain('### Lab 8.3 — Uninstall Istio Ambient');
  expect(md).toContain('helm uninstall ztunnel');
  expect(md).toContain('helm uninstall istio-cni');
  expect(md).toContain('helm uninstall istiod');
  expect(md).toContain('helm uninstall istio-base');
  expect(md).toContain('kubectl --context=$EAST_CONTEXT delete namespace istio-system');
});

test('InstallAdapter.generateCleanupSections labels each cluster with bold text, not a bare markdown heading', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generateCleanupSections(8, singleClusterSelection, 3)[0];
  expect(md).toContain('**Uninstall on `east`**');
  expect(md).not.toMatch(/^# east$/m);
});

test('InstallAdapter.generateCleanupSections uninstalls components in reverse of install order', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generateCleanupSections(8, singleClusterSelection, 3)[0];
  const ztunnelIdx = md.indexOf('helm uninstall ztunnel');
  const cniIdx = md.indexOf('helm uninstall istio-cni');
  const istiodIdx = md.indexOf('helm uninstall istiod');
  const baseIdx = md.indexOf('helm uninstall istio-base');
  expect(ztunnelIdx).toBeLessThan(cniIdx);
  expect(cniIdx).toBeLessThan(istiodIdx);
  expect(istiodIdx).toBeLessThan(baseIdx);
});

test('InstallAdapter.generateCleanupSections uninstalls peering-eastwest from the istio-eastwest namespace, not istio-system', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generateCleanupSections(8, multiClusterSelection, 3)[0];
  expect(md).toContain('helm uninstall peering-eastwest --kube-context=$EAST_CONTEXT -n istio-eastwest');
  expect(md).not.toContain('helm uninstall peering-eastwest --kube-context=$EAST_CONTEXT -n istio-system');
  expect(md).toContain('kubectl --context=$EAST_CONTEXT delete namespace istio-eastwest');
});

test('InstallAdapter.generateCleanupSections unlinks clusters before per-cluster uninstall in multicluster', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generateCleanupSections(8, multiClusterSelection, 3)[0];
  expect(md).toContain('Unlink clusters first');
  expect(md).toContain('helm uninstall peering-remote');
  const unlinkIdx = md.indexOf('Unlink clusters first');
  const perClusterIdx = md.indexOf('Uninstall Istio components on each cluster');
  expect(unlinkIdx).toBeLessThan(perClusterIdx);
});

test('InstallAdapter.generateCleanupSections returns an empty array when there are no clusters', () => {
  const adapter = new InstallAdapter();
  const selection = { infraProfile: { spec: { clusters: [] } }, profile: { spec: {} } };
  expect(adapter.generateCleanupSections(8, selection, 1)).toEqual([]);
});
