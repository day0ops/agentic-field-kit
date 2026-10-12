import { Feature } from '../../../src/lib/feature.js';

const DIGEST_PIN_PATTERN = /^[^\s@]+@sha256:[a-f0-9]{64}$/;

/**
 * SubstrateAgentFeature
 *
 * Applies a kagent `Harness` + one or more `AgentTemplate`s (kagent.dev/v1alpha3,
 * kagent 1.0.0-alpha5's architecture generation) that run as Actors on Agent
 * Substrate. Assumes the kagent addon already created and owns `namespace` --
 * this feature does not create or Ambient-label it.
 *
 * This generation has no `Agent` CRD: a Harness admits AgentTemplates via
 * `spec.allowedAgentTemplates.selector`, a label selector matched against
 * each AgentTemplate's own labels, rather than a separate resource pairing
 * one specific template to one specific Harness. Invocation (choosing which
 * admitted template actually runs) happens at call time via the gRPC
 * `CreateAgentInstance(Harness, AgentTemplate)` API -- the caller names both
 * explicitly, so there's no persistent "entry point" resource here. See
 * features/agentic/fraud-ops-console for a caller that does this, driven by
 * its own `FRAUD_SWARM_HARNESS`/`FRAUD_LEAD_AGENT_TEMPLATE` env vars.
 *
 * Backward-compatible: with no `agents` list it builds a single AgentTemplate
 * named after `config.name` (the original single-agent behavior). With an
 * `agents` list it builds one AgentTemplate per entry, all sharing one
 * Harness + WorkerPool -- the swarm case, where entries can bind each other
 * as tools (sub-agent delegation) and/or bind MCP servers.
 *
 * `Harness.spec.workload.image` must be a real, digest-pinned image `ate-api`
 * can pull (CRD-enforced pattern name@sha256:<64 hex>); if it can't, the golden
 * actor fails at CallAteletRestore. References an existing ModelConfig rather
 * than creating one -- kagent-enterprise auto-generates a `default-model-config`
 * ModelConfig from `providers.default`. The WorkerPool referenced by
 * `workerPoolName` defaults to `kagent-default`, created by the kagent addon's
 * own `substrateWorkerPool.create` Helm value -- that mechanism only ever
 * creates that one pool, so a custom `workerPoolName` (e.g. a swarm's own
 * small pool) is only created if `workerImage` is also set (see
 * `buildWorkerPool`); live-confirmed (2026-09-28) that a Harness pointed at a
 * WorkerPool nobody created just sits on `ResolvedRefs: WorkerPoolNotFound`.
 *
 * Configuration:
 * {
 *   name: string,               // Harness resource name. Default: 'substrate-demo'
 *   namespace: string,          // Required -- must match the kagent addon's namespace
 *   image: string,              // Required -- digest-pinned Harness workload image
 *   modelConfigRef: string,     // Default: 'default-model-config' (single-agent mode)
 *   workerPoolName: string,     // Default: 'kagent-default'
 *   workerImage: string,        // Optional -- if set, this feature also creates its own WorkerPool named workerPoolName
 *   workerPoolReplicas: number, // Default: 1 (only used when workerImage is set)
 *   sandboxClass: string,       // Default: 'gvisor' (only used when workerImage is set)
 *   snapshots: {                 // Harness snapshotPolicy.location. Both this and the kagent addon's
 *                                 // own substrate.snapshots should read the same infra-provisioned
 *                                 // value, so a Harness's snapshot location always agrees with the
 *                                 // worker's storage backend/credentials.
 *     bucket: string,            // Full bucket URI with scheme (e.g. 'gs://my-bucket' or
 *                                 // 's3://my-bucket'), normally templated in as
 *                                 // infra.clusters.<name>.storage.snapshotBucket -- never hand-typed.
 *                                 // Omit to fall back to the bundled RustFS default.
 *     location: string,          // Explicit full override; wins over bucket when set.
 *   },
 *   modelConfig: {              // Optional -- if set, this feature also creates its own ModelConfig
 *     name: string,             // Default: '<name>-model-config'
 *     provider: string,         // Required, e.g. 'OpenAI'
 *     model: string,            // Required, e.g. 'gpt-4.1-mini'
 *     apiKeySecret: string,     // Required -- Secret name holding the provider API key
 *     apiKeySecretKey: string,  // Required -- key within apiKeySecret
 *     defaultHeaders: object,   // Optional -- extra HTTP headers on every provider request.
 *                               // `{ Connection: 'close' }` disables client-side connection
 *                               // reuse -- live-confirmed (2026-09-28) as the workaround for
 *                               // a real kagent/go bug: Agent Substrate checkpoints an actor
 *                               // immediately after a turn ends, freezing the model client's
 *                               // pooled keep-alive connections; on the next resume the process
 *                               // reuses one whose remote end died while frozen, surfacing as
 *                               // "read: connection reset by peer" on the next real request.
 *   },
 *   description: string,      // AgentTemplate description (single-agent mode)
 *   systemPrompt: string,     // AgentTemplate system prompt (single-agent mode)
 *   agents: [{                // Swarm mode: one AgentTemplate per entry, all admitted onto the
 *                               // same Harness. By convention agents[0] is the entry point a
 *                               // caller names in CreateAgentInstance; agents[1:] are specialists
 *                               // only reachable via another agent's `agent` tool binding -- there
 *                               // is no CRD-level distinction between them in this architecture.
 *     name: string,
 *     description: string,
 *     systemPrompt: string,
 *     modelConfigRef: string, // Default: config.modelConfigRef
 *     tools: [
 *       { agent: string, description: string }, // delegate to another agent in this list (-> CRD's agent tool)
 *       { mcp: string, tools: string[] }, // bind a RemoteMCPServer named `mcp`; `tools` optionally limits exposed tools
 *     ],
 *   }],
 * }
 */
export class SubstrateAgentFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);
    this.harnessName = config.name || 'substrate-demo';
    this.image = config.image;
    this.workerPoolName = config.workerPoolName || 'kagent-default';
    this.workerImage = config.workerImage;
    this.workerPoolReplicas = config.workerPoolReplicas || 1;
    this.sandboxClass = config.sandboxClass || 'gvisor';
    const snapshots = config.snapshots || {};
    this.snapshotBucket = snapshots.bucket || null;
    this.snapshotLocation =
      snapshots.location ||
      (this.snapshotBucket
        ? `${this.snapshotBucket}/${this.namespace}/`
        : `s3://ate-snapshots/${this.namespace}/`);
    this.modelConfig = config.modelConfig || null;
    this.modelConfigName = this.modelConfig
      ? this.modelConfig.name || `${this.harnessName}-model-config`
      : null;
    this.defaultModelConfigRef =
      config.modelConfigRef || this.modelConfigName || 'default-model-config';

    if (Array.isArray(config.agents) && config.agents.length > 0) {
      this.agents = config.agents;
    } else {
      this.agents = [
        {
          name: this.harnessName,
          description: config.description || 'A substrate-backed assistant.',
          systemPrompt:
            config.systemPrompt ||
            'You are a helpful assistant running inside a gVisor-sandboxed actor on Agent Substrate. Answer concisely.',
          modelConfigRef: config.modelConfigRef,
        },
      ];
    }
  }

  getFeaturePath() {
    return 'agentic/substrate-agent';
  }

  validate() {
    if (!this.image) throw new Error('substrate-agent: image is required');
    if (!DIGEST_PIN_PATTERN.test(this.image)) {
      throw new Error(
        'substrate-agent: image must be digest-pinned (name@sha256:<64 hex>) -- required by the Harness CRD'
      );
    }
    if (!this.workerPoolName) throw new Error('substrate-agent: workerPoolName is required');
    if (this.modelConfig) {
      for (const field of ['provider', 'model', 'apiKeySecret', 'apiKeySecretKey']) {
        if (!this.modelConfig[field]) {
          throw new Error(`substrate-agent: modelConfig.${field} is required`);
        }
      }
    }
    const names = new Set(this.agents.map(a => a.name));
    for (const a of this.agents) {
      if (!a.name) throw new Error('substrate-agent: every agent needs a name');
      for (const t of a.tools || []) {
        if (t.agent && !names.has(t.agent)) {
          throw new Error(
            `substrate-agent: agent tool '${t.agent}' is not one of the agents in this swarm`
          );
        }
        if (t.mcp === '' || (t.mcp === undefined && t.agent === undefined)) {
          throw new Error('substrate-agent: each tool must set either agent or mcp');
        }
      }
    }
    return true;
  }

  // buildWorkerPool returns a dedicated WorkerPool CR (ate.dev/v1alpha1) when
  // workerImage is set, or undefined when it isn't -- backward-compatible
  // with the original single-agent usage, which relies on the kagent addon's
  // own Helm-templated `kagent-default` WorkerPool already existing. A custom
  // workerPoolName (e.g. a swarm's own small pool) is never auto-created by
  // anything else, so callers wanting one must supply workerImage.
  //
  // The `kagent.dev/worker-pool: <name>` label mirrors the kagent-enterprise
  // Helm chart's own WorkerPool template exactly (charts/kagent-enterprise/
  // templates/substrate-workerpool.yaml) -- kagent's own chart-created pools
  // (e.g. kagent-default) always carry it. ate-api's scheduler filters
  // candidate workers by the ActorTemplate's worker label selector
  // (scheduling.Applies), so a WorkerPool missing whatever label that
  // selector requires produces workers that read as healthy/FREE individually
  // but are never eligible -- live-confirmed (2026-09-28) as
  // ResourceExhausted: "no free workers available" on every resume attempt,
  // regardless of replica count.
  buildWorkerPool() {
    if (!this.workerImage) return undefined;
    return {
      apiVersion: 'ate.dev/v1alpha1',
      kind: 'WorkerPool',
      metadata: {
        name: this.workerPoolName,
        namespace: this.namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'agentic-demo',
          'kagent.dev/worker-pool': this.workerPoolName,
        },
      },
      spec: {
        replicas: this.workerPoolReplicas,
        sandboxClass: this.sandboxClass,
        workerImage: this.workerImage,
      },
    };
  }

  // buildModelConfig returns a dedicated ModelConfig CR when config.modelConfig is set,
  // or undefined when it isn't -- backward-compatible with the original usage, which
  // relies on the kagent-enterprise chart's own auto-generated 'default-model-config'.
  // A caller wanting its own ModelConfig (e.g. to set defaultHeaders) must supply
  // config.modelConfig explicitly.
  buildModelConfig() {
    if (!this.modelConfig) return undefined;
    return {
      apiVersion: 'kagent.dev/v1alpha3',
      kind: 'ModelConfig',
      metadata: {
        name: this.modelConfigName,
        namespace: this.namespace,
        labels: { 'app.kubernetes.io/managed-by': 'agentic-demo' },
      },
      spec: {
        provider: this.modelConfig.provider,
        model: this.modelConfig.model,
        apiKeySecret: this.modelConfig.apiKeySecret,
        apiKeySecretKey: this.modelConfig.apiKeySecretKey,
        ...(this.modelConfig.defaultHeaders
          ? { defaultHeaders: this.modelConfig.defaultHeaders }
          : {}),
      },
    };
  }

  buildHarness() {
    return {
      apiVersion: 'kagent.dev/v1alpha3',
      kind: 'Harness',
      metadata: {
        name: this.harnessName,
        namespace: this.namespace,
        labels: { 'app.kubernetes.io/managed-by': 'agentic-demo' },
      },
      spec: {
        kagent: {},
        workload: { image: this.image },
        substrate: {
          workerPoolRef: { name: this.workerPoolName },
          snapshotPolicy: { location: this.snapshotLocation },
        },
        // No Agent CRD in this architecture generation: a Harness admits whichever
        // AgentTemplates match this selector, rather than being paired to one specific
        // template. Matches the 'kagent.dev/harness' label every AgentTemplate below carries.
        allowedAgentTemplates: {
          selector: { matchLabels: { 'kagent.dev/harness': this.harnessName } },
        },
      },
    };
  }

  #buildTools(tools) {
    if (!tools || tools.length === 0) return undefined;
    return tools.map(t => {
      if (t.agent) {
        return {
          agent: {
            name: t.agent,
            description: t.description || `Delegate to ${t.agent}`,
            templateRef: { name: t.agent },
            isolation: 'Shared',
          },
        };
      }
      return {
        mcp: {
          // Live-confirmed CEL validation on AgentTemplate.spec.tools[].mcp.server:
          // kind must equal 'RemoteMCPServer' and apiGroup must be entirely absent
          // (not even empty string) -- binding a kagent.dev/v1alpha1 MCPServer
          // directly is rejected at admission. Point this at a RemoteMCPServer
          // that fronts the actual MCP server (e.g. kagent-mcp-server now creates
          // one automatically alongside its MCPServer).
          server: {
            kind: 'RemoteMCPServer',
            name: t.mcp,
          },
          ...(t.tools ? { tools: t.tools } : {}),
        },
      };
    });
  }

  buildAgentTemplates() {
    return this.agents.map(a => {
      const tools = this.#buildTools(a.tools);
      const spec = {
        modelConfig: { name: a.modelConfigRef || this.defaultModelConfigRef },
        description: a.description || 'A substrate-backed assistant.',
        systemPrompt: a.systemPrompt || 'You are a helpful assistant. Answer concisely.',
      };
      if (tools) spec.tools = tools;
      return {
        apiVersion: 'kagent.dev/v1alpha3',
        kind: 'AgentTemplate',
        metadata: {
          name: a.name,
          namespace: this.namespace,
          labels: {
            'app.kubernetes.io/managed-by': 'agentic-demo',
            'kagent.dev/harness': this.harnessName,
          },
        },
        spec,
      };
    });
  }

  async deploy() {
    const modelConfig = this.buildModelConfig();
    if (modelConfig) {
      await this.applyResource(modelConfig);
    }
    const workerPool = this.buildWorkerPool();
    if (workerPool) {
      await this.applyResource(workerPool);
    }
    await this.applyResource(this.buildHarness());
    for (const tpl of this.buildAgentTemplates()) {
      await this.applyResource(tpl);
    }
    this.log(
      `Harness '${this.harnessName}' + ${this.agents.length} AgentTemplate(s) applied in '${this.namespace}'`,
      'success'
    );
  }

  async cleanup() {
    for (const a of this.agents) {
      await this.deleteResource('AgentTemplate', a.name, this.namespace);
    }
    await this.deleteResource('Harness', this.harnessName, this.namespace);
    if (this.workerImage) {
      await this.deleteResource('WorkerPool', this.workerPoolName, this.namespace);
    }
    if (this.modelConfig) {
      await this.deleteResource('ModelConfig', this.modelConfigName, this.namespace);
    }
    this.log(`substrate-agent '${this.harnessName}' cleaned up`, 'success');
  }
}
