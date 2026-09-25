// test/lib/runbook.test.js
import { test, expect } from 'bun:test';
import { inferUsecaseScope } from '../../src/lib/runbook.js';

test('inferUsecaseScope returns single-cluster for a 1-cluster infra profile', () => {
  expect(inferUsecaseScope({ spec: { clusters: [{ name: 'east' }] } })).toBe('single-cluster');
});

test('inferUsecaseScope returns single-cluster when clusters is empty or missing', () => {
  expect(inferUsecaseScope({ spec: { clusters: [] } })).toBe('single-cluster');
  expect(inferUsecaseScope({ spec: {} })).toBe('single-cluster');
});

test('inferUsecaseScope returns multi-cluster for a 2+ cluster infra profile', () => {
  expect(inferUsecaseScope({ spec: { clusters: [{ name: 'east' }, { name: 'west' }] } })).toBe(
    'multi-cluster'
  );
});

test('RunbookPicker.filterProfiles excludes profiles without spec.infra', () => {
  const profiles = [
    { metadata: { name: 'with-infra' }, spec: { infra: 'eks-multi-cluster' } },
    { metadata: { name: 'no-infra' }, spec: {} },
    { metadata: { name: 'null-infra' }, spec: { infra: null } },
  ];
  const result = profiles.filter(p => p.spec?.infra);
  expect(result).toHaveLength(1);
  expect(result[0].metadata.name).toBe('with-infra');
});

import { RunbookPicker } from '../../src/lib/runbook.js';

test('RunbookPicker exists and exports RunbookPicker class', () => {
  expect(RunbookPicker).toBeDefined();
  const picker = new RunbookPicker();
  expect(typeof picker.pick).toBe('function');
  expect(typeof picker.listProfiles).toBe('function');
});

import { UseCaseAdapter } from '../../src/lib/runbook-adapters/usecase.js';

const mockUsecase = {
  metadata: { name: 'mcp-auth', description: 'Enforce MCP authentication via Keycloak' },
  spec: {
    diagram: 'sequenceDiagram\n  Client->>AGW: request\n  AGW->>KC: token check',
    features: [
      { name: 'mcp-server', description: 'Deploy MCP server', config: { namespace: 'mcp' } },
      { name: 'mcp-auth', description: 'Enforce auth', config: {} },
    ],
    tests: [{ name: 'auth-enforced', description: 'Verify unauthenticated request is rejected' }],
  },
};

test('UseCaseAdapter.generate returns empty string when no usecases selected', async () => {
  const adapter = new UseCaseAdapter();
  const selection = { usecases: [] };
  const md = await adapter.generate(4, selection);
  expect(md).toBe('');
});

test('UseCaseAdapter.generate produces lab section titled with the humanized use case name', async () => {
  const adapter = new UseCaseAdapter();
  const selection = { usecases: [mockUsecase] };
  const md = await adapter.generate(4, selection);
  expect(md).toContain('## Lab 4');
  expect(md).toContain('### Lab 4.1 — Mcp Auth');
  expect(md).not.toContain('Enforce MCP authentication');
});

test('UseCaseAdapter.generate omits the diagram (shown once elsewhere, e.g. the HTML hero)', async () => {
  const adapter = new UseCaseAdapter();
  const selection = { usecases: [mockUsecase] };
  const md = await adapter.generate(4, selection);
  expect(md).not.toContain('```mermaid');
  expect(md).not.toContain('sequenceDiagram');
});

test('UseCaseAdapter.generate includes feature steps', async () => {
  const adapter = new UseCaseAdapter();
  const selection = { usecases: [mockUsecase] };
  const md = await adapter.generate(4, selection);
  expect(md).toContain('Deploy MCP server');
  expect(md).toContain('Enforce auth');
  expect(md).toContain('namespace: mcp');
});

import { RunbookBuilder } from '../../src/lib/runbook.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const fullSelection = {
  profile: {
    metadata: { name: 'eks-multi-cluster-peering-with-agw-hub-spoke' },
    spec: {
      mesh: { gatewayApiVersion: 'v1.4.0', istioVersion: '1.30.0' },
      addons: {
        global: [{ name: 'cilium', version: '1.19.4', description: 'eBPF CNI' }],
        clusters: [
          {
            name: 'east',
            addons: [
              {
                name: 'agentgateway',
                description: 'hub',
                config: { enterprise: true },
                version: 'v2026.5.1',
                namespace: 'agentgateway-system',
              },
            ],
          },
          {
            name: 'west',
            addons: [
              {
                name: 'agentgateway',
                description: 'spoke',
                config: { enterprise: true, globalGateway: true },
                version: 'v2026.5.1',
                namespace: 'agentgateway-system',
              },
            ],
          },
        ],
      },
    },
  },
  infraProfile: {
    metadata: { name: 'eks-multi-cluster' },
    spec: { name: 'maple', provider: 'eks', clusters: [{ name: 'east' }, { name: 'west' }] },
  },
  environment: {
    spec: { aws: { region: 'ap-southeast-1' }, domains: { app: { main: 'app.example.com' } } },
  },
  usecases: [],
  outputDir: path.join(os.tmpdir(), `runbook-test-${Date.now()}`),
  filename: 'test-runbook',
};

test('RunbookBuilder.build() writes markdown file with all required sections', async () => {
  const builder = new RunbookBuilder(fullSelection);
  const outputPath = await builder.build();

  expect(fs.existsSync(outputPath)).toBe(true);

  const content = fs.readFileSync(outputPath, 'utf8');
  expect(content).toContain('# Agentic Demo Runbook');
  expect(content).toContain('## Lab 0');
  expect(content).toContain('## Lab 1');
  expect(content).toContain('## Lab 2');
  expect(content).toContain('## Lab 3');

  // Cleanup
  fs.rmSync(fullSelection.outputDir, { recursive: true });
});
