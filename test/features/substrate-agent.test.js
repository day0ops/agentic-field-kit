import { describe, it, expect } from 'bun:test';
import { SubstrateAgentFeature } from '../../features/agentic/substrate-agent/index.js';

const IMG =
  'ghcr.io/kagent-dev/kagent/golang-adk@sha256:0ef67974d39518b18de074bd9762fb4aea9764fc8836eeb45d7868b358eecb30';

describe('substrate-agent single-agent (backward compat)', () => {
  const f = new SubstrateAgentFeature('substrate-agent', {
    name: 'substrate-demo',
    namespace: 'kagent',
    image: IMG,
    workerPoolName: 'kagent-default',
  });
  it('builds exactly one AgentTemplate named after config.name', () => {
    const tpls = f.buildAgentTemplates();
    expect(tpls.length).toBe(1);
    expect(tpls[0].metadata.name).toBe('substrate-demo');
    expect(tpls[0].metadata.labels['kagent.dev/harness']).toBe('substrate-demo');
    expect(tpls[0].spec.tools).toBeUndefined();
  });
  it('harness references the shared WorkerPool and admits its own AgentTemplates', () => {
    const h = f.buildHarness();
    expect(h.apiVersion).toBe('kagent.dev/v1alpha3');
    expect(h.metadata.name).toBe('substrate-demo');
    expect(h.spec.substrate.workerPoolRef.name).toBe('kagent-default');
    expect(h.spec.workload.image).toBe(IMG);
    expect(h.spec.allowedAgentTemplates.selector.matchLabels).toEqual({
      'kagent.dev/harness': 'substrate-demo',
    });
  });
  it('builds no WorkerPool when workerImage is not set (relies on the addon-owned pool)', () => {
    expect(f.buildWorkerPool()).toBeUndefined();
  });
  it('builds no ModelConfig when modelConfig is not set (relies on the chart-owned default)', () => {
    expect(f.buildModelConfig()).toBeUndefined();
    expect(f.buildAgentTemplates()[0].spec.modelConfig.name).toBe('default-model-config');
  });
});

describe('substrate-agent modelConfig', () => {
  const f = new SubstrateAgentFeature('substrate-agent', {
    name: 'fraud-swarm',
    namespace: 'kagent',
    image: IMG,
    workerPoolName: 'fraud-workers',
    modelConfig: {
      provider: 'OpenAI',
      model: 'gpt-4.1-mini',
      apiKeySecret: 'kagent-openai',
      apiKeySecretKey: 'OPENAI_API_KEY',
      defaultHeaders: { Connection: 'close' },
    },
  });
  it('builds a dedicated ModelConfig named after the harness by default', () => {
    const mc = f.buildModelConfig();
    expect(mc.apiVersion).toBe('kagent.dev/v1alpha3');
    expect(mc.kind).toBe('ModelConfig');
    expect(mc.metadata.name).toBe('fraud-swarm-model-config');
    expect(mc.spec).toEqual({
      provider: 'OpenAI',
      model: 'gpt-4.1-mini',
      apiKeySecret: 'kagent-openai',
      apiKeySecretKey: 'OPENAI_API_KEY',
      defaultHeaders: { Connection: 'close' },
    });
  });
  it('AgentTemplates reference the dedicated ModelConfig by default', () => {
    const tpl = f.buildAgentTemplates()[0];
    expect(tpl.spec.modelConfig.name).toBe('fraud-swarm-model-config');
  });
  it('validate throws when a required modelConfig field is missing', () => {
    const bad = new SubstrateAgentFeature('substrate-agent', {
      name: 'fraud-swarm',
      namespace: 'kagent',
      image: IMG,
      workerPoolName: 'fraud-workers',
      modelConfig: { provider: 'OpenAI', model: 'gpt-4.1-mini' },
    });
    expect(() => bad.validate()).toThrow('apiKeySecret');
  });
});

describe('substrate-agent swarm', () => {
  const f = new SubstrateAgentFeature('substrate-agent', {
    name: 'fraud-swarm',
    namespace: 'kagent',
    image: IMG,
    workerPoolName: 'fraud-workers',
    workerImage: 'ghcr.io/kagent-dev/substrate/ateom-gvisor:v0.2.0-beta5',
    workerPoolReplicas: 2,
    agents: [
      {
        name: 'fraud-lead-investigator',
        description: 'lead',
        systemPrompt: 'You lead the case.',
        modelConfigRef: 'lead-model-config',
        tools: [
          { agent: 'tx-analyst', description: 'Pull account history' },
          { mcp: 'core-banking-mcp' },
        ],
      },
      { name: 'tx-analyst', description: 'history', systemPrompt: 'You pull history.' },
    ],
  });
  it('builds one AgentTemplate per agent, all sharing the harness label', () => {
    const tpls = f.buildAgentTemplates();
    expect(tpls.map(t => t.metadata.name).sort()).toEqual([
      'fraud-lead-investigator',
      'tx-analyst',
    ]);
    for (const t of tpls) {
      expect(t.metadata.labels['kagent.dev/harness']).toBe('fraud-swarm');
    }
  });
  it('maps agent-as-tool and mcp bindings to the CRD shape', () => {
    const lead = f.buildAgentTemplates().find(t => t.metadata.name === 'fraud-lead-investigator');
    const agentTool = lead.spec.tools.find(t => t.agent);
    expect(agentTool.agent.templateRef.name).toBe('tx-analyst');
    expect(agentTool.agent.name).toBe('tx-analyst');
    expect(agentTool.agent.isolation).toBe('Shared');
    const mcpTool = lead.spec.tools.find(t => t.mcp);
    expect(mcpTool.mcp.server).toEqual({ kind: 'RemoteMCPServer', name: 'core-banking-mcp' });
  });
  it('per-agent modelConfigRef overrides, harness stays single', () => {
    const lead = f.buildAgentTemplates().find(t => t.metadata.name === 'fraud-lead-investigator');
    expect(lead.spec.modelConfig.name).toBe('lead-model-config');
    expect(f.buildHarness().metadata.name).toBe('fraud-swarm');
  });
  it('builds a dedicated WorkerPool when workerImage is set', () => {
    const wp = f.buildWorkerPool();
    expect(wp.apiVersion).toBe('ate.dev/v1alpha1');
    expect(wp.kind).toBe('WorkerPool');
    expect(wp.metadata.name).toBe('fraud-workers');
    expect(wp.spec.replicas).toBe(2);
    expect(wp.spec.workerImage).toBe('ghcr.io/kagent-dev/substrate/ateom-gvisor:v0.2.0-beta5');
    expect(wp.spec.sandboxClass).toBe('gvisor');
    // Mirrors the kagent-enterprise chart's own WorkerPool label exactly --
    // ate-api's scheduler filters candidate workers by this selector.
    expect(wp.metadata.labels['kagent.dev/worker-pool']).toBe('fraud-workers');
  });
});

describe('substrate-agent snapshots', () => {
  it('defaults to the bundled RustFS (s3) bucket', () => {
    const f = new SubstrateAgentFeature('substrate-agent', {
      name: 'substrate-demo',
      namespace: 'kagent',
      image: IMG,
      workerPoolName: 'kagent-default',
    });
    expect(f.buildHarness().spec.substrate.snapshotPolicy.location).toBe(
      's3://ate-snapshots/kagent/'
    );
  });

  it('uses bucket for a GCS URI, with no explicit backend choice needed', () => {
    const f = new SubstrateAgentFeature('substrate-agent', {
      name: 'substrate-demo',
      namespace: 'kagent',
      image: IMG,
      workerPoolName: 'kagent-default',
      snapshots: { bucket: 'gs://my-bucket' },
    });
    expect(f.buildHarness().spec.substrate.snapshotPolicy.location).toBe('gs://my-bucket/kagent/');
  });

  it('uses bucket for an S3 URI the same way', () => {
    const f = new SubstrateAgentFeature('substrate-agent', {
      name: 'substrate-demo',
      namespace: 'kagent',
      image: IMG,
      workerPoolName: 'kagent-default',
      snapshots: { bucket: 's3://my-bucket' },
    });
    expect(f.buildHarness().spec.substrate.snapshotPolicy.location).toBe('s3://my-bucket/kagent/');
  });

  it('honors an explicit location override', () => {
    const f = new SubstrateAgentFeature('substrate-agent', {
      name: 'substrate-demo',
      namespace: 'kagent',
      image: IMG,
      workerPoolName: 'kagent-default',
      snapshots: { location: 'gs://custom/path/' },
    });
    expect(f.buildHarness().spec.substrate.snapshotPolicy.location).toBe('gs://custom/path/');
  });

  it('location wins over bucket when both are set', () => {
    const f = new SubstrateAgentFeature('substrate-agent', {
      name: 'substrate-demo',
      namespace: 'kagent',
      image: IMG,
      workerPoolName: 'kagent-default',
      snapshots: { bucket: 'gs://my-bucket', location: 'gs://custom/path/' },
    });
    expect(f.buildHarness().spec.substrate.snapshotPolicy.location).toBe('gs://custom/path/');
  });
});
