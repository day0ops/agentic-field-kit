// test/lib/runbook-adapters/addon.test.js
import { test, expect } from 'bun:test';
import { AddonAdapter } from '../../../src/lib/runbook-adapters/addon.js';

const mockSelection = {
  profile: {
    spec: {
      addons: {
        global: [
          { name: 'cilium', version: '1.19.4' },
          { name: 'cert-manager', version: '1.20.2' },
        ],
        clusters: [
          { name: 'east', addons: [{ name: 'external-dns' }, { name: 'keycloak' }] },
          { name: 'west', addons: [{ name: 'telemetry', config: { mode: 'agent' } }] },
        ],
      },
    },
  },
  infraProfile: { spec: { clusters: [{ name: 'east' }, { name: 'west' }] } },
  environment: { spec: {} },
};

test('AddonAdapter._iterateAddons expands each global addon to one entry per real cluster', async () => {
  const adapter = new AddonAdapter();
  const addons = await adapter._iterateAddons(mockSelection);
  expect(addons[0].addon.name).toBe('cilium');
  expect(addons[0].clusterName).toBe('east');
  expect(addons[1].addon.name).toBe('cilium');
  expect(addons[1].clusterName).toBe('west');
  expect(addons[2].addon.name).toBe('cert-manager');
  expect(addons[2].clusterName).toBe('east');
  expect(addons[3].addon.name).toBe('cert-manager');
  expect(addons[3].clusterName).toBe('west');
});

test('AddonAdapter._iterateAddons preserves per-cluster order after globals', async () => {
  const adapter = new AddonAdapter();
  const addons = await adapter._iterateAddons(mockSelection);
  const names = addons.map(a => `${a.addon.name}@${a.clusterName}`);
  expect(names).toEqual([
    'cilium@east',
    'cilium@west',
    'cert-manager@east',
    'cert-manager@west',
    'external-dns@east',
    'keycloak@east',
    'telemetry@west',
  ]);
});

test('AddonAdapter._iterateAddons falls back to a single "global" entry when no infraProfile clusters are known', async () => {
  const adapter = new AddonAdapter();
  const selection = {
    profile: { spec: { addons: { global: [{ name: 'cilium' }], clusters: [] } } },
    environment: { spec: {} },
  };
  const addons = await adapter._iterateAddons(selection);
  expect(addons).toHaveLength(1);
  expect(addons[0].clusterName).toBe('global');
});

test('AddonAdapter._iterateAddons returns null sidecar for unknown addon', async () => {
  const adapter = new AddonAdapter();
  const selection = {
    profile: { spec: { addons: { global: [{ name: 'nonexistent-addon-xyz' }], clusters: [] } } },
    environment: { spec: {} },
  };
  const addons = await adapter._iterateAddons(selection);
  expect(addons[0].addon.name).toBe('nonexistent-addon-xyz');
  expect(addons[0].sidecar).toBeNull();
});

test('AddonAdapter.generate includes Lab heading and sub-lab headings', async () => {
  const adapter = new AddonAdapter();
  const selection = {
    profile: { spec: { addons: { global: [{ name: 'nonexistent-xyz' }], clusters: [] } } },
    environment: { spec: {} },
  };
  const md = await adapter.generate(3, selection);
  expect(md).toContain('## Lab 3');
  expect(md).toContain('### Lab 3.1');
  expect(md).toContain('nonexistent-xyz');
});

test('AddonAdapter.generateCleanupSections uninstalls addons in reverse order of installation', async () => {
  const adapter = new AddonAdapter();
  const sections = await adapter.generateCleanupSections(8, mockSelection, 2);
  expect(sections).toHaveLength(1);
  const md = sections[0];
  expect(md).toContain('### Lab 8.2 — Uninstall Addons');

  // installed order: cilium (east, west), cert-manager (east, west), external-dns (east),
  // keycloak (east), telemetry (west) — cleanup should reverse it
  const telemetryIdx = md.indexOf('telemetry (west)');
  const keycloakIdx = md.indexOf('keycloak (east)');
  const externalDnsIdx = md.indexOf('external-dns (east)');
  const certManagerWestIdx = md.indexOf('cert-manager (west)');
  const certManagerEastIdx = md.indexOf('cert-manager (east)');
  const ciliumWestIdx = md.indexOf('cilium (west)');
  const ciliumEastIdx = md.indexOf('cilium (east)');
  expect(telemetryIdx).toBeGreaterThan(-1);
  expect(keycloakIdx).toBeGreaterThan(telemetryIdx);
  expect(externalDnsIdx).toBeGreaterThan(keycloakIdx);
  expect(certManagerWestIdx).toBeGreaterThan(externalDnsIdx);
  expect(certManagerEastIdx).toBeGreaterThan(certManagerWestIdx);
  expect(ciliumWestIdx).toBeGreaterThan(certManagerEastIdx);
  expect(ciliumEastIdx).toBeGreaterThan(ciliumWestIdx);
  expect(md).toContain('helm uninstall');
});

test('AddonAdapter.generatePreambles returns one preamble per addon needing one, decoupled from generate()', async () => {
  const adapter = new AddonAdapter();
  const selection = {
    profile: {
      spec: {
        addons: {
          global: [{ name: 'spire', config: { trustDomain: '{{cluster.name}}.local', distinctRoots: true } }],
          clusters: [],
        },
      },
    },
    infraProfile: { spec: { clusters: [{ name: 'east' }, { name: 'west' }] } },
    environment: { spec: {} },
  };
  const preambles = await adapter.generatePreambles(selection);
  expect(preambles).toHaveLength(1);
  expect(preambles[0]).toContain('Generate independent SPIRE roots');
  expect(preambles[0]).toContain('east.local');
  expect(preambles[0]).toContain('west.local');

  // generate() itself no longer renders the preamble body inline — it's rendered separately,
  // as part of the earlier "Cluster Bootstrap" lab (see RunbookBuilder._assemble()). Per-cluster
  // sections may still legitimately cross-reference it by name, so check for the preamble's
  // actual content (the root-generation commands), not the bare phrase.
  const md = await adapter.generate(5, selection);
  expect(md).not.toContain('Each of these clusters gets its own independent root CA');
  const eastIdx = md.indexOf('### Lab 5.1 — spire (east)');
  const westIdx = md.indexOf('### Lab 5.2 — spire (west)');
  expect(eastIdx).toBeGreaterThan(-1);
  expect(westIdx).toBeGreaterThan(eastIdx);
});

test('AddonAdapter.generateCleanupSections returns an empty array when there are no addons', async () => {
  const adapter = new AddonAdapter();
  const selection = { profile: { spec: { addons: { global: [], clusters: [] } } } };
  const sections = await adapter.generateCleanupSections(8, selection, 1);
  expect(sections).toEqual([]);
});
