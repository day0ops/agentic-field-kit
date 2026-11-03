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
    expect(tpls[0].apiVersion).toBe('api.kagent.dev/v1alpha3');
    expect(tpls[0].metadata.name).toBe('substrate-demo');
    expect(tpls[0].metadata.labels['kagent.dev/harness']).toBe('substrate-demo');
    expect(tpls[0].spec.tools).toBeUndefined();
  });
  it('harness references the shared WorkerPool and no longer sets allowedAgentTemplates', () => {
    const h = f.buildHarness();
    expect(h.apiVersion).toBe('api.kagent.dev/v1alpha3');
    expect(h.metadata.name).toBe('substrate-demo');
    expect(h.spec.substrate.workerPoolRef.name).toBe('kagent-default');
    expect(h.spec.workload.image).toBe(IMG);
    expect(h.spec.allowedAgentTemplates).toBeUndefined();
  });
  it('builds one Agent per AgentTemplate, pairing it to the Harness', () => {
    const agents = f.buildAgents();
    expect(agents.length).toBe(1);
    expect(agents[0].apiVersion).toBe('api.kagent.dev/v1alpha3');
    expect(agents[0].kind).toBe('Agent');
    expect(agents[0].metadata.name).toBe('substrate-demo');
    expect(agents[0].spec.harnessRef).toEqual({ name: 'substrate-demo' });
    expect(agents[0].spec.template.ref).toEqual({ name: 'substrate-demo' });
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
    expect(mc.apiVersion).toBe('api.kagent.dev/v1alpha3');
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
    workerImage: 'ghcr.io/kagent-dev/substrate/ateom-gvisor:v0.6.0-b15382d4',
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
      expect(t.apiVersion).toBe('api.kagent.dev/v1alpha3');
      expect(t.metadata.labels['kagent.dev/harness']).toBe('fraud-swarm');
    }
  });
  it('builds one Agent per agent, each pairing its own AgentTemplate to the shared Harness', () => {
    const agents = f.buildAgents();
    expect(agents.map(a => a.metadata.name).sort()).toEqual([
      'fraud-lead-investigator',
      'tx-analyst',
    ]);
    for (const a of agents) {
      expect(a.spec.harnessRef).toEqual({ name: 'fraud-swarm' });
    }
    const lead = agents.find(a => a.metadata.name === 'fraud-lead-investigator');
    expect(lead.spec.template.ref).toEqual({ name: 'fraud-lead-investigator' });
  });
  it('maps agent-as-tool to a subAgent binding, with no isolation field', () => {
    const lead = f.buildAgentTemplates().find(t => t.metadata.name === 'fraud-lead-investigator');
    const subAgentTool = lead.spec.tools.find(t => t.subAgent);
    expect(subAgentTool.subAgent.templateRef).toEqual({ name: 'tx-analyst' });
    expect(subAgentTool.subAgent.name).toBe('tx-analyst');
    expect(subAgentTool.subAgent.isolation).toBeUndefined();
    expect(subAgentTool.agent).toBeUndefined();
  });
  it('maps mcp bindings to the CRD shape unchanged', () => {
    const lead = f.buildAgentTemplates().find(t => t.metadata.name === 'fraud-lead-investigator');
    const mcpTool = lead.spec.tools.find(t => t.mcp);
    expect(mcpTool.mcp.server).toEqual({ kind: 'RemoteMCPServer', name: 'core-banking-mcp' });
  });
  it('per-agent modelConfigRef overrides, harness stays single', () => {
    const lead = f.buildAgentTemplates().find(t => t.metadata.name === 'fraud-lead-investigator');
    expect(lead.spec.modelConfig.name).toBe('lead-model-config');
    expect(f.buildHarness().metadata.name).toBe('fraud-swarm');
  });
  it('builds a dedicated WorkerPool with a sandboxClasses list when workerImage is set', () => {
    const wp = f.buildWorkerPool();
    expect(wp.apiVersion).toBe('ate.dev/v1');
    expect(wp.kind).toBe('WorkerPool');
    expect(wp.metadata.name).toBe('fraud-workers');
    expect(wp.spec.replicas).toBe(2);
    expect(wp.spec.workerImage).toBe('ghcr.io/kagent-dev/substrate/ateom-gvisor:v0.6.0-b15382d4');
    expect(wp.spec.sandboxClasses).toEqual([{ name: 'gvisor' }]);
    expect(wp.spec.sandboxClass).toBeUndefined();
    // Must match the chart's own WorkerPool label pair -- every compiled worker_selector
    // requires it.
    expect(wp.metadata.labels['kagent.dev/worker-pool-name']).toBe('fraud-workers');
    expect(wp.metadata.labels['kagent.dev/worker-pool-namespace']).toBe('kagent');
    expect(wp.spec.template.resources.requests.cpu).toBe('1100m');
    expect(wp.spec.template.resources.limits.cpu).toBe('1500m');
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
