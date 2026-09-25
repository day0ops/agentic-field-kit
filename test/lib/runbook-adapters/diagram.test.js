// test/lib/runbook-adapters/diagram.test.js
import { test, expect } from 'bun:test';
import { DiagramAdapter } from '../../../src/lib/runbook-adapters/diagram.js';

const baseSelection = {
  infraProfile: {
    spec: {
      name: 'maple',
      provider: 'eks',
      clusters: [{ name: 'east' }, { name: 'west' }],
    },
  },
  profile: {
    spec: {
      addons: {
        global: [
          { name: 'cilium', description: 'eBPF-based CNI' },
          { name: 'cert-manager', description: 'Certificate management' },
        ],
        clusters: [
          {
            name: 'east',
            addons: [
              {
                name: 'agentgateway',
                description: 'AI Gateway Enterprise hub',
                config: { enterprise: true },
              },
              { name: 'keycloak', description: 'OIDC provider' },
              { name: 'telemetry', config: {} },
              { name: 'solo-ui', mode: 'management' },
            ],
          },
          {
            name: 'west',
            addons: [
              {
                name: 'agentgateway',
                description: 'AI Gateway Enterprise spoke',
                config: { enterprise: true, globalGateway: true },
              },
              { name: 'telemetry', config: { mode: 'agent' } },
              { name: 'solo-ui', mode: 'relay' },
            ],
          },
        ],
      },
    },
  },
};

test('DiagramAdapter.generate includes one mermaid code block', () => {
  const adapter = new DiagramAdapter();
  const md = adapter.generate(2, baseSelection);
  expect(md).toContain('## Lab 2');
  const mermaidBlocks = (md.match(/```mermaid/g) || []).length;
  expect(mermaidBlocks).toBe(1);
  expect(md).not.toContain('Component Interaction');
});

test('DiagramAdapter topology diagram uses <br> not \\n in node labels', () => {
  const adapter = new DiagramAdapter();
  const md = adapter.generate(2, baseSelection);
  expect(md).toContain('<br>');
  expect(md).not.toContain('\\n');
});

test('DiagramAdapter topology diagram contains subgraphs for each cluster', () => {
  const adapter = new DiagramAdapter();
  const md = adapter.generate(2, baseSelection);
  expect(md).toContain('subgraph EAST');
  expect(md).toContain('subgraph WEST');
});

test('DiagramAdapter topology diagram contains global addons node', () => {
  const adapter = new DiagramAdapter();
  const md = adapter.generate(2, baseSelection);
  expect(md).toContain('cilium');
  expect(md).toContain('cert-manager');
  expect(md).toContain('GLOBAL');
});

test('DiagramAdapter topology diagram includes addon nodes for each cluster', () => {
  const adapter = new DiagramAdapter();
  const md = adapter.generate(2, baseSelection);
  expect(md).toContain('agentgateway');
  expect(md).toContain('keycloak');
});

test('DiagramAdapter.generate includes component descriptions section', () => {
  const adapter = new DiagramAdapter();
  const md = adapter.generate(2, baseSelection);
  expect(md).toContain('### Component Descriptions');
  expect(md).toContain('eBPF-based CNI');
});

test('DiagramAdapter.generate renders component descriptions as a card grid with name/scope/description', () => {
  const adapter = new DiagramAdapter();
  const md = adapter.generate(2, baseSelection);
  expect(md).toContain('<div class="component-grid">');
  expect(md).toContain('<div class="component-card">');
  expect(md).toContain('<span class="component-name">cilium</span>');
  expect(md).toContain('<span class="component-scope">global</span>');
  expect(md).toContain('<span class="component-name">keycloak</span>');
  expect(md).toContain('<span class="component-scope">east</span>');
  expect(md).toContain('<p class="component-desc">eBPF-based CNI</p>');
});

test('DiagramAdapter.generate escapes HTML-special characters in addon descriptions', () => {
  const adapter = new DiagramAdapter();
  const selection = {
    infraProfile: { spec: { name: 'maple', provider: 'eks', clusters: [{ name: 'east' }] } },
    profile: {
      spec: {
        addons: {
          global: [{ name: 'weird', description: 'A <script>alert(1)</script> & "quote"' }],
          clusters: [],
        },
      },
    },
  };
  const md = adapter.generate(2, selection);
  expect(md).not.toContain('<script>');
  expect(md).toContain('&lt;script&gt;');
});

test('DiagramAdapter topology diagram truncates long node descriptions at a word boundary, not mid-word', () => {
  const adapter = new DiagramAdapter();
  const selection = {
    infraProfile: { spec: { name: 'maple', provider: 'eks', clusters: [{ name: 'east' }] } },
    profile: {
      spec: {
        addons: {
          global: [],
          clusters: [
            {
              name: 'east',
              addons: [
                {
                  name: 'external-dns',
                  description:
                    'Automatic DNS record management via Route53 with health checks and failover',
                },
              ],
            },
          ],
        },
      },
    },
  };
  const md = adapter.generate(2, selection);
  expect(md).not.toContain('Rout<');
  expect(md).not.toContain('Rout"');
  expect(md).toContain('Automatic DNS record management via Route53');
});
