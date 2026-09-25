import { Feature } from '../../../src/lib/feature.js';

/**
 * ProvidersFeature
 *
 * Configures LLM providers for agentgateway with complete (Enterprise)AgentgatewayBackend
 * and HTTPRoute setup.
 *
 * Ported from the reference implementation; adapted for:
 *   - Enterprise CRDs (EnterpriseAgentgatewayBackend) when `enterprise: true`
 *   - Gateway from config (gatewayName / gatewayNamespace) instead of FeatureManager.getGatewayRef
 *   - agentic-demo managed-by labels
 *
 * Reference: https://docs.solo.io/agentgateway/latest/llm/providers/
 *
 * Configuration (two modes):
 *
 * Mode 1 — Single providers (backward compatible):
 * {
 *   enterprise: boolean,        // Use EnterpriseAgentgatewayBackend (default: false)
 *   namespace: string,          // Target namespace (required)
 *   gatewayName: string,        // Parent Gateway name (required)
 *   gatewayNamespace: string,   // Parent Gateway namespace (default: namespace)
 *   providers: [
 *     {
 *       name: string,           // Provider identifier (Backend resource name)
 *       providerName: string,   // Optional: actual provider type (openai, anthropic, etc.)
 *       pathPrefix: string,     // Optional: HTTP path prefix (default: '/<name>')
 *       pathRewrite: string,    // Optional: ReplacePrefixMatch value e.g. '/' to strip prefix
 *       model: string,          // Optional: default model
 *       region: string,         // Optional: AWS region (Bedrock)
 *       authMode: string,       // Optional: 'none' | 'passthrough' | 'credentials'
 *       hostname: string,       // Optional: virtual hostname for HTTPRoute
 *     }
 *   ]
 * }
 *
 * Mode 2 — Groups (priority failover / load balancing):
 * {
 *   enterprise: boolean,
 *   namespace: string,
 *   gatewayName: string,
 *   gatewayNamespace: string,
 *   groups: [
 *     {
 *       name: string,           // Optional group label
 *       providers: [
 *         {
 *           name: string,       // Free-form identifier (SectionName in NamedLLMProvider)
 *           providerName: string,  // Actual provider type
 *           model: string,
 *           policies: { auth: {...}, ai: {...} }
 *         }
 *       ],
 *       policies: { auth: {...}, ai: {...} }
 *     }
 *   ],
 *   pathPrefix: string          // Default: '/providers'
 * }
 *
 * Simple shorthand (Mode 1):
 *   providers: ['openai', 'bedrock']   // Uses defaults
 *
 * Required env vars per provider:
 *   openai        → OPENAI_API_KEY
 *   anthropic     → ANTHROPIC_API_KEY
 *   azure-openai  → AZURE_OPENAI_API_KEY
 *   gemini        → GEMINI_API_KEY
 *   bedrock (credentials) → AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 *   bedrock (default)     → AWS_BEDROCK_API_KEY
 *   vertex-ai     → GOOGLE_APPLICATION_CREDENTIALS
 *   openai-compatible (with auth) → OPENAI_COMPATIBLE_API_KEY
 */
export class ProvidersFeature extends Feature {
  constructor(name, config = {}) {
    super(name, config);

    this.enterprise = config.enterprise === true;
    this.gatewayName = config.gatewayName;
    this.gatewayNamespace = config.gatewayNamespace || config.namespace;

    this.useGroups = !!config.groups;

    if (this.useGroups) {
      this.groups = config.groups || [];
      this.pathPrefix = config.pathPrefix || '/providers';
    } else {
      this.normalizedProviders = this.normalizeProviders(config.providers || []);
      this.bodyRouting = !!config.bodyRouting;
      this.bodyRoutingFallback =
        this.bodyRouting && this.normalizedProviders.some(p => p.fallbackModel);
      this.queryParamRouting = !!config.queryParamRouting;
      this.queryParamName = config.queryParamName || 'model';
      this.singleRoute = this.bodyRouting || this.queryParamRouting || !!config.singleRoute;
      this.pathPrefix = config.pathPrefix || '/chat';

      const pathKey =
        this.pathPrefix.replace(/\//g, '-').replace(/^-/, '').replace(/-$/, '') || 'default';
      this.routeName = `providers-${pathKey}-route`;
      this.policyName = `body-routing-policy-${pathKey}`;
      this.fallbackBackendName = `providers-fallback-${pathKey}`;
    }
  }

  getFeaturePath() {
    return 'agentic/providers';
  }

  // ── CRD helpers ────────────────────────────────────────────────────────────

  #backendApiVersion() {
    return this.enterprise
      ? 'enterpriseagentgateway.solo.io/v1alpha1'
      : 'agentgateway.dev/v1alpha1';
  }

  #backendKind() {
    return this.enterprise ? 'EnterpriseAgentgatewayBackend' : 'AgentgatewayBackend';
  }

  #backendGroup() {
    return this.enterprise ? 'enterpriseagentgateway.solo.io' : 'agentgateway.dev';
  }

  // ── Provider normalization ─────────────────────────────────────────────────

  normalizeProviders(providers) {
    return providers.map(provider => {
      if (typeof provider === 'string') {
        return {
          name: provider,
          providerName: provider,
          pathPrefix: `/${provider}`,
          model: this.getDefaultModel(provider),
          region: provider === 'bedrock' ? 'us-east-1' : undefined,
        };
      }
      const providerName = provider.providerName || provider.name;
      const base = {
        name: provider.name,
        providerName,
        pathPrefix: provider.pathPrefix || `/${provider.name}`,
        model: provider.model || undefined,
        region: provider.region || undefined,
        location: provider.location || undefined,
        authMode: provider.authMode,
        modelMatch: provider.modelMatch,
        fallbackModel: provider.fallbackModel,
        ...(provider.guardrail ? { guardrail: provider.guardrail } : {}),
        ...(provider.policies ? { policies: provider.policies } : {}),
        ...(provider.pathRewrite != null ? { pathRewrite: provider.pathRewrite } : {}),
        ...(provider.hostname ? { hostname: provider.hostname } : {}),
      };
      if (providerName === 'openai-compatible') {
        return { ...base, ...this.applyOpenAICompatibleDefaults(provider) };
      }
      return base;
    });
  }

  static getOpenAICompatibleDefaults() {
    return { host: 'localhost', port: 11434, path: { full: '/v1/chat/completions' } };
  }

  applyOpenAICompatibleDefaults(config) {
    const defaults = ProvidersFeature.getOpenAICompatibleDefaults();
    return {
      ...defaults,
      ...config,
      path: config.path ? { ...defaults.path, ...config.path } : defaults.path,
    };
  }

  getDefaultModel(providerName) {
    const defaults = {
      openai: 'gpt-4',
      anthropic: 'claude-3-sonnet-20240229',
      'azure-openai': 'gpt-4',
      bedrock: 'global.amazon.nova-2-lite-v1:0',
      gemini: 'google/gemini-2.5-flash',
      'vertex-ai': 'google/gemini-2.5-flash',
      'openai-compatible': '',
    };
    return defaults[providerName] || '';
  }

  // ── Validation ─────────────────────────────────────────────────────────────

  validate() {
    if (!this.gatewayName) throw new Error('providers: gatewayName is required');
    if (!this.namespace) throw new Error('providers: namespace is required');

    if (this.useGroups) {
      if (!this.groups?.length) throw new Error('providers: no groups specified');
      for (const g of this.groups) {
        if (!g.providers?.length)
          throw new Error('providers: each group must have at least one provider');
      }
      const seen = new Set();
      for (const g of this.groups) {
        for (const p of g.providers) {
          const n = typeof p === 'string' ? p : p.name;
          if (seen.has(n))
            throw new Error(`providers: provider name '${n}' must be unique across all groups`);
          seen.add(n);
        }
      }
    } else {
      if (!this.normalizedProviders.length) throw new Error('providers: no providers specified');
    }
    return true;
  }

  // ── Deploy entry ───────────────────────────────────────────────────────────

  async deploy() {
    const contexts =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];

    for (const ctx of contexts) {
      if (this.useGroups) {
        await this.deployGroups(ctx);
      } else {
        await this.deploySingleProviders(ctx);
      }
    }
  }

  // ── Groups mode ────────────────────────────────────────────────────────────

  async deployGroups(context) {
    const allProviders = [];
    for (const group of this.groups) {
      for (const p of group.providers) {
        const cfg = typeof p === 'string' ? { name: p } : p;
        allProviders.push({ providerName: cfg.providerName || cfg.name, config: cfg });
      }
    }

    if (!this.dryRun) {
      this.#assertEnvVars(allProviders.map(a => ({ provider: a.providerName, config: a.config })));
    }

    const createdSecrets = new Set();
    for (const { providerName, config } of allProviders) {
      if (!createdSecrets.has(providerName)) {
        if (this.getRequiredEnvVars(config).length > 0) {
          if (providerName === 'bedrock' && config.authMode === 'credentials') {
            await this.createBedrockSecret(context);
          } else {
            await this.createProviderSecret(config, context);
          }
        }
        createdSecrets.add(providerName);
      }
    }

    await this.createBackendWithGroups(context);
    await this.createHTTPRouteForGroups(context);
  }

  // ── Single providers mode ──────────────────────────────────────────────────

  async deploySingleProviders(context) {
    if (!this.dryRun) {
      this.#assertEnvVars(
        this.normalizedProviders.map(p => ({ provider: p.providerName || p.name, config: p }))
      );
    }

    for (const provider of this.normalizedProviders) {
      this.log(`Configuring provider: ${provider.name}`, 'info');
      if (this.getRequiredEnvVars(provider).length > 0) {
        if (provider.providerName === 'bedrock' && provider.authMode === 'credentials') {
          await this.createBedrockSecret(context);
        } else {
          await this.createProviderSecret(provider, context);
        }
      }
      await this.createBackend(provider, context);
      if (!this.singleRoute) {
        await this.createHTTPRoute(provider, context);
      }
      this.log(
        `Provider ${provider.name} configured${this.singleRoute ? '' : ` at ${provider.pathPrefix}`}`,
        'info'
      );
    }

    if (this.singleRoute && this.normalizedProviders.length > 0) {
      if (this.bodyRouting) {
        await this.createBodyRoutingPolicy(context);
        if (this.bodyRoutingFallback) await this.createFallbackGroupsBackend(context);
        await this.createBodyRoutingHTTPRoute(context);
      } else if (this.queryParamRouting) {
        await this.createQueryParamRoutingHTTPRoute(context);
      } else {
        await this.createSingleRouteWithBackendRefs(context);
      }
    }
  }

  // ── Secrets ────────────────────────────────────────────────────────────────

  async createProviderSecret(provider, context) {
    const providerName = provider.providerName || provider.name;
    const secretName = providerName === 'gemini' ? 'google-secret' : `${providerName}-secret`;
    const apiKey = this.dryRun
      ? `<set ${this.getEnvVarName(providerName)}>`
      : process.env[this.getEnvVarName(providerName)];

    await this.applyResource(
      {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: secretName,
          namespace: this.namespace,
          labels: {
            'app.kubernetes.io/managed-by': 'agentic-demo',
            'agentgateway.dev/feature': this.name,
          },
        },
        type: 'Opaque',
        stringData: { Authorization: apiKey },
      },
      context
    );

    if (!this.dryRun) this.log(`Created secret ${secretName}`, 'info');
  }

  async createBedrockSecret(context) {
    const secretData = this.dryRun
      ? { accessKey: '<set AWS_ACCESS_KEY_ID>', secretKey: '<set AWS_SECRET_ACCESS_KEY>' }
      : {
          accessKey: process.env.AWS_ACCESS_KEY_ID,
          secretKey: process.env.AWS_SECRET_ACCESS_KEY,
          ...(process.env.AWS_SESSION_TOKEN && { sessionToken: process.env.AWS_SESSION_TOKEN }),
        };

    await this.applyYamlFile(
      'bedrock-secret.yaml',
      {
        metadata: { namespace: this.namespace },
        stringData: secretData,
      },
      context
    );

    if (!this.dryRun) this.log('Created Bedrock secret with AWS credentials', 'info');
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  async cleanup() {
    const labels = {
      'app.kubernetes.io/managed-by': 'agentic-demo',
      'agentgateway.dev/feature': this.name,
    };

    const contexts =
      this.clusterContexts?.length > 0 ? this.clusterContexts.map(c => c.context) : [null];

    for (const ctx of contexts) {
      if (this.spinner?.isSpinning) this.spinner.setText('Cleaning up provider HTTPRoutes...');
      await this.deleteByLabel('HTTPRoute', labels, this.namespace, ctx);

      if (this.spinner?.isSpinning) this.spinner.setText('Cleaning up provider backends...');
      await this.deleteByLabel('AgentgatewayBackend', labels, this.namespace, ctx);
      if (this.enterprise) {
        await this.deleteByLabel('EnterpriseAgentgatewayBackend', labels, this.namespace, ctx);
      }

      if (this.spinner?.isSpinning) this.spinner.setText('Cleaning up provider secrets...');
      await this.deleteByLabel('Secret', labels, this.namespace, ctx);

      await this.deleteByLabel('EnterpriseAgentgatewayPolicy', labels, this.namespace, ctx);
    }
  }

  // ── Auth policy ────────────────────────────────────────────────────────────

  static isAnthropicModel(model) {
    return model && (model.startsWith('anthropic/') || model.startsWith('claude-'));
  }

  static normalizeAnthropicModel(model) {
    if (!model) return model;
    if (model.startsWith('claude-')) return `anthropic/${model}`;
    return model;
  }

  static getVertexAnthropicAiPolicy(providerName, model) {
    if (providerName !== 'vertex-ai' || !ProvidersFeature.isAnthropicModel(model)) return null;
    const fullModel = ProvidersFeature.normalizeAnthropicModel(model);
    const bareName = fullModel.slice('anthropic/'.length);
    const atIdx = bareName.indexOf('@');
    const baseName = atIdx >= 0 ? bareName.substring(0, atIdx) : bareName;
    return {
      modelAliases: {
        [bareName]: fullModel,
        [`${baseName}@*`]: fullModel,
        [`${baseName}-*`]: fullModel,
      },
    };
  }

  static mergeAiPolicy(providerName, model, explicitAiPolicy) {
    const generated = ProvidersFeature.getVertexAnthropicAiPolicy(providerName, model);
    if (!generated && !explicitAiPolicy) return undefined;
    if (!generated) return explicitAiPolicy;
    if (!explicitAiPolicy) return generated;
    return {
      ...generated,
      ...explicitAiPolicy,
      routes: { ...generated.routes, ...(explicitAiPolicy.routes || {}) },
      modelAliases: { ...generated.modelAliases, ...(explicitAiPolicy.modelAliases || {}) },
    };
  }

  getBackendAuthPolicy(providerName, secretName, provider) {
    if (provider.authMode === 'none') return {};
    if (provider.authMode === 'passthrough') return { passthrough: {}, secretRef: undefined };
    if (providerName === 'bedrock' && provider.authMode === 'credentials') {
      return { aws: { secretRef: { name: secretName } }, secretRef: undefined };
    }
    if (providerName === 'openai-compatible' && !provider.policies?.auth?.secretRef) return {};
    return { secretRef: { name: secretName } };
  }

  // ── Backend creation ───────────────────────────────────────────────────────

  async createBackend(provider, context) {
    const providerName = provider.providerName || provider.name;
    const secretName =
      providerName === 'bedrock'
        ? 'bedrock-secret'
        : providerName === 'gemini'
          ? 'google-secret'
          : providerName === 'vertex-ai'
            ? 'vertex-ai-secret'
            : `${providerName}-secret`;

    const authPolicy = this.getBackendAuthPolicy(providerName, secretName, provider);
    const hasAuth = authPolicy && Object.keys(authPolicy).length > 0;
    const backendProvider =
      provider.modelMatch === 'RegularExpression' ? { ...provider, model: undefined } : provider;
    const llmConfig = this.getBackendLLMConfig(backendProvider);
    const aiSpec = { provider: llmConfig };

    const overrides = {
      apiVersion: this.#backendApiVersion(),
      kind: this.#backendKind(),
      metadata: {
        name: provider.name,
        namespace: this.namespace,
        labels: {
          'agentgateway.dev/feature': this.name,
          'agentgateway.dev/provider': provider.name,
        },
      },
      spec: {
        ai: aiSpec,
        policies: (() => {
          const p = {};
          p.auth = hasAuth ? authPolicy : undefined;
          const aiPolicy = ProvidersFeature.mergeAiPolicy(
            providerName,
            provider.model,
            provider.policies?.ai
          );
          if (aiPolicy) p.ai = aiPolicy;
          return Object.values(p).some(v => v !== undefined) ? p : undefined;
        })(),
      },
    };

    await this.applyYamlFile('backend.yaml', overrides, context);
    this.log(`${this.#backendKind()} created for ${provider.name}`, 'info');
  }

  getBackendLLMConfig(provider) {
    const config = {};
    const providerName = provider.providerName || provider.name;

    switch (providerName) {
      case 'openai':
        config.openai = { model: provider.model };
        break;

      case 'anthropic':
        config.anthropic = { model: provider.model };
        break;

      case 'azure-openai':
        config.azureopenai = {
          endpoint: provider.endpoint || process.env.AZURE_OPENAI_ENDPOINT || '',
          deploymentName: provider.deploymentName || provider.model || '',
          apiVersion: provider.apiVersion || 'v1',
        };
        break;

      case 'bedrock':
        config.bedrock = {
          model: provider.model,
          region: provider.region || 'us-east-1',
        };
        if (provider.guardrail) {
          config.bedrock.guardrail = {};
          if (provider.guardrail.guardrailId)
            config.bedrock.guardrail.guardrailId = provider.guardrail.guardrailId;
          if (provider.guardrail.guardrailVersion)
            config.bedrock.guardrail.guardrailVersion = provider.guardrail.guardrailVersion;
        }
        break;

      case 'gemini':
        config.gemini = { model: provider.model };
        break;

      case 'vertex-ai': {
        const projectId = provider.projectId || process.env.GCP_PROJECT || '';
        if (!projectId)
          throw new Error(
            `vertex-ai provider "${provider.name}" requires projectId or GCP_PROJECT env var`
          );
        config.vertexai = {
          model: ProvidersFeature.normalizeAnthropicModel(provider.model),
          projectId,
          region: provider.location || process.env.GCP_LOCATION || 'us-central1',
        };
        if (provider.modelPath) config.vertexai.modelPath = provider.modelPath;
        break;
      }

      case 'openai-compatible': {
        const defaults = ProvidersFeature.getOpenAICompatibleDefaults();
        const host = provider.host ?? defaults.host;
        const port = provider.port ?? defaults.port;
        const pathObj = provider.path ? { ...defaults.path, ...provider.path } : defaults.path;
        const pathStr =
          typeof pathObj === 'string' ? pathObj : (pathObj?.full ?? '/v1/chat/completions');
        config.openai = { model: provider.model };
        if (provider.authHeader) config.openai.authHeader = provider.authHeader;
        config.host = host;
        config.port = port;
        config.path = pathStr;
        break;
      }

      default:
        config.openai = { model: provider.model };
        if (provider.authHeader) config.openai.authHeader = provider.authHeader;
    }

    return config;
  }

  // ── HTTPRoute creation ─────────────────────────────────────────────────────

  async createHTTPRoute(provider, context) {
    const rule = {
      matches: [{ path: { value: provider.pathPrefix } }],
      backendRefs: [
        {
          name: provider.name,
          namespace: this.namespace,
          group: this.#backendGroup(),
          kind: this.#backendKind(),
        },
      ],
    };

    if (provider.pathRewrite != null) {
      rule.filters = [
        {
          type: 'URLRewrite',
          urlRewrite: {
            path: { type: 'ReplacePrefixMatch', replacePrefixMatch: provider.pathRewrite },
          },
        },
      ];
    }

    const overrides = {
      metadata: {
        name: provider.name,
        namespace: this.namespace,
        labels: {
          'agentgateway.dev/feature': this.name,
          'agentgateway.dev/provider': provider.name,
        },
      },
      spec: {
        parentRefs: [{ name: this.gatewayName, namespace: this.gatewayNamespace }],
        ...(provider.hostname && { hostnames: [provider.hostname] }),
        rules: [rule],
      },
    };

    await this.applyYamlFile('httproute.yaml', overrides, context);
    const rewriteMsg = provider.pathRewrite != null ? ` (rewrite → ${provider.pathRewrite})` : '';
    this.log(
      `HTTPRoute created for ${provider.name} at ${provider.pathPrefix}${rewriteMsg}`,
      'info'
    );
  }

  async createSingleRouteWithBackendRefs(context) {
    const backendRefs = this.normalizedProviders.map(p => ({
      name: p.name,
      namespace: this.namespace,
      group: this.#backendGroup(),
      kind: this.#backendKind(),
    }));

    const overrides = {
      metadata: {
        name: this.routeName,
        namespace: this.namespace,
        labels: {
          'agentgateway.dev/feature': this.name,
          'agentgateway.dev/mode': 'single-route',
        },
      },
      spec: {
        parentRefs: [{ name: this.gatewayName, namespace: this.gatewayNamespace }],
        rules: [{ matches: [{ path: { value: this.pathPrefix } }], backendRefs }],
      },
    };

    await this.applyYamlFile('httproute.yaml', overrides, context);
    this.log(
      `HTTPRoute created (single route) at ${this.pathPrefix} with ${backendRefs.length} backendRefs`,
      'info'
    );
  }

  async createBodyRoutingPolicy(context) {
    const setHeaders = [{ name: 'X-Gateway-Model-Name', value: 'json(request.body).model' }];
    if (this.bodyRoutingFallback) {
      setHeaders.push({
        name: 'X-Gateway-Model-Status',
        value: 'default(json(request.body).model, "") != "" ? "specified" : "unspecified"',
      });
    }

    await this.applyResource(
      {
        apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
        kind: 'EnterpriseAgentgatewayPolicy',
        metadata: {
          name: this.policyName,
          namespace: this.namespace,
          labels: {
            'app.kubernetes.io/managed-by': 'agentic-demo',
            'agentgateway.dev/feature': this.name,
          },
        },
        spec: {
          targetRefs: [
            { group: 'gateway.networking.k8s.io', kind: 'Gateway', name: this.gatewayName },
          ],
          traffic: {
            phase: 'PreRouting',
            transformation: { request: { set: setHeaders } },
          },
        },
      },
      context
    );

    this.log('EnterpriseAgentgatewayPolicy created for body-based routing', 'info');
  }

  async createFallbackGroupsBackend(context) {
    const groups = [];

    for (const provider of this.normalizedProviders) {
      const providerName = provider.providerName || provider.name;
      const fallbackModel =
        provider.fallbackModel ||
        (provider.modelMatch === 'RegularExpression' ? undefined : provider.model);
      const llmConfig = this.getBackendLLMConfig({ ...provider, model: fallbackModel });

      let secretName;
      if (providerName === 'bedrock') secretName = 'bedrock-secret';
      else if (providerName === 'gemini') secretName = 'google-secret';
      else if (providerName === 'vertex-ai') secretName = 'vertex-ai-secret';
      else secretName = `${providerName}-secret`;

      const authPolicy = this.getBackendAuthPolicy(providerName, secretName, provider);
      const hasAuth = authPolicy && Object.keys(authPolicy).length > 0;
      const aiPolicy = ProvidersFeature.mergeAiPolicy(
        providerName,
        fallbackModel,
        provider.policies?.ai
      );

      const namedProvider = { name: provider.name, ...llmConfig };
      const policies = {};
      if (hasAuth) policies.auth = authPolicy;
      if (aiPolicy) policies.ai = aiPolicy;
      if (Object.keys(policies).length > 0) namedProvider.policies = policies;

      groups.push({ providers: [namedProvider] });
    }

    const overrides = {
      apiVersion: this.#backendApiVersion(),
      kind: this.#backendKind(),
      metadata: {
        name: this.fallbackBackendName,
        namespace: this.namespace,
        labels: {
          'agentgateway.dev/feature': this.name,
          'agentgateway.dev/mode': 'body-routing-fallback',
        },
      },
      spec: {
        ai: { groups, provider: undefined },
        policies: undefined,
      },
    };

    await this.applyYamlFile('backend.yaml', overrides, context);
    this.log(
      `${this.#backendKind()} created for fallback with ${groups.length} failover group(s)`,
      'info'
    );
  }

  async createBodyRoutingHTTPRoute(context) {
    const modelRules = this.normalizedProviders
      .filter(p => p.model)
      .map(provider => {
        const headerMatch = { name: 'X-Gateway-Model-Name', value: provider.model };
        if (provider.modelMatch === 'RegularExpression') headerMatch.type = 'RegularExpression';
        const rule = {
          matches: [{ path: { value: this.pathPrefix }, headers: [headerMatch] }],
          backendRefs: [
            {
              name: provider.name,
              namespace: this.namespace,
              group: this.#backendGroup(),
              kind: this.#backendKind(),
            },
          ],
        };
        if (provider.pathRewrite != null) {
          rule.filters = [
            {
              type: 'URLRewrite',
              urlRewrite: {
                path: { type: 'ReplacePrefixMatch', replacePrefixMatch: provider.pathRewrite },
              },
            },
          ];
        }
        return rule;
      });

    const rules = [...modelRules];
    if (this.bodyRoutingFallback) {
      rules.push({
        matches: [
          {
            path: { value: this.pathPrefix },
            headers: [{ name: 'X-Gateway-Model-Status', value: 'unspecified' }],
          },
        ],
        backendRefs: [
          {
            name: this.fallbackBackendName,
            namespace: this.namespace,
            group: this.#backendGroup(),
            kind: this.#backendKind(),
          },
        ],
      });
    }

    const overrides = {
      metadata: {
        name: this.routeName,
        namespace: this.namespace,
        labels: { 'agentgateway.dev/feature': this.name, 'agentgateway.dev/mode': 'body-routing' },
      },
      spec: {
        parentRefs: [{ name: this.gatewayName, namespace: this.gatewayNamespace }],
        rules,
      },
    };

    await this.applyYamlFile('httproute.yaml', overrides, context);
    this.log(
      `HTTPRoute created (body routing) at ${this.pathPrefix} with ${modelRules.length} model rule(s)`,
      'info'
    );
  }

  async createQueryParamRoutingHTTPRoute(context) {
    const rules = this.normalizedProviders
      .filter(p => p.model)
      .map(provider => {
        const rule = {
          matches: [
            {
              path: { value: this.pathPrefix },
              queryParams: [{ type: 'Exact', name: this.queryParamName, value: provider.model }],
            },
          ],
          backendRefs: [
            {
              name: provider.name,
              namespace: this.namespace,
              group: this.#backendGroup(),
              kind: this.#backendKind(),
            },
          ],
          timeouts: { request: '120s' },
        };
        if (provider.pathRewrite != null) {
          rule.filters = [
            {
              type: 'URLRewrite',
              urlRewrite: {
                path: { type: 'ReplacePrefixMatch', replacePrefixMatch: provider.pathRewrite },
              },
            },
          ];
        }
        return rule;
      });

    const overrides = {
      metadata: {
        name: this.routeName,
        namespace: this.namespace,
        labels: {
          'agentgateway.dev/feature': this.name,
          'agentgateway.dev/mode': 'query-param-routing',
        },
      },
      spec: {
        parentRefs: [{ name: this.gatewayName, namespace: this.gatewayNamespace }],
        rules,
      },
    };

    await this.applyYamlFile('httproute.yaml', overrides, context);
    this.log(
      `HTTPRoute created (query param routing) at ${this.pathPrefix}?${this.queryParamName}=…`,
      'info'
    );
  }

  // ── Groups mode backend + route ────────────────────────────────────────────

  async createBackendWithGroups(context) {
    const groups = [];

    for (const groupConfig of this.groups) {
      const providers = [];

      for (const p of groupConfig.providers) {
        const cfg = typeof p === 'string' ? { name: p } : p;
        const actualProviderName = cfg.providerName || cfg.name;
        const llmConfig = this.getBackendLLMConfig({ name: actualProviderName, ...cfg });

        const namedProvider = { name: cfg.name, ...llmConfig };

        const explicitPolicies = cfg.policies || {};
        const aiPolicy = ProvidersFeature.mergeAiPolicy(
          actualProviderName,
          cfg.model,
          explicitPolicies.ai
        );
        const merged = { ...explicitPolicies };
        if (aiPolicy) merged.ai = aiPolicy;
        if (merged.auth && !(merged.auth.secretRef || merged.auth.aws)) delete merged.auth;
        if (Object.keys(merged).length > 0) namedProvider.policies = merged;

        providers.push(namedProvider);
      }

      const group = { providers };
      if (groupConfig.policies) group.policies = groupConfig.policies;
      groups.push(group);
    }

    const overrides = {
      apiVersion: this.#backendApiVersion(),
      kind: this.#backendKind(),
      metadata: {
        name: 'providers-groups',
        namespace: this.namespace,
        labels: {
          'agentgateway.dev/feature': this.name,
          'agentgateway.dev/mode': 'groups',
        },
      },
      spec: {
        ai: { groups, provider: undefined },
        policies: undefined,
      },
    };

    await this.applyYamlFile('backend.yaml', overrides, context);
    this.log(`${this.#backendKind()} created with groups configuration`, 'info');
  }

  async createHTTPRouteForGroups(context) {
    const overrides = {
      metadata: {
        name: 'providers-groups',
        namespace: this.namespace,
        labels: {
          'agentgateway.dev/feature': this.name,
          'agentgateway.dev/mode': 'groups',
        },
      },
      spec: {
        parentRefs: [{ name: this.gatewayName, namespace: this.gatewayNamespace }],
        rules: [
          {
            matches: [{ path: { value: this.pathPrefix } }],
            backendRefs: [
              {
                name: 'providers-groups',
                namespace: this.namespace,
                group: this.#backendGroup(),
                kind: this.#backendKind(),
              },
            ],
          },
        ],
      },
    };

    await this.applyYamlFile('httproute.yaml', overrides, context);
    this.log(`HTTPRoute created for groups at ${this.pathPrefix}`, 'info');
  }

  // ── Env var helpers ────────────────────────────────────────────────────────

  getRequiredEnvVars(provider) {
    const name = typeof provider === 'string' ? provider : provider.providerName || provider.name;
    const authMode = typeof provider === 'object' ? provider.authMode : undefined;

    if (authMode === 'passthrough' || authMode === 'none') return [];

    if (name === 'bedrock') {
      return authMode === 'credentials'
        ? ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']
        : ['AWS_BEDROCK_API_KEY'];
    }

    if (name === 'openai-compatible') {
      return typeof provider === 'object' && provider.policies?.auth?.secretRef
        ? ['OPENAI_COMPATIBLE_API_KEY']
        : [];
    }

    const envVarMap = {
      openai: ['OPENAI_API_KEY'],
      anthropic: ['ANTHROPIC_API_KEY'],
      'azure-openai': ['AZURE_OPENAI_API_KEY'],
      gemini: ['GEMINI_API_KEY'],
      'vertex-ai': ['GOOGLE_APPLICATION_CREDENTIALS'],
    };

    return envVarMap[name] || [`${String(name).toUpperCase().replace(/-/g, '_')}_API_KEY`];
  }

  getEnvVarName(provider) {
    return this.getRequiredEnvVars(provider)[0];
  }

  #assertEnvVars(providerList) {
    const missing = [];
    for (const { provider, config } of providerList) {
      for (const envVar of this.getRequiredEnvVars(config)) {
        if (!process.env[envVar]) missing.push(`  - ${provider}: ${envVar} not set`);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables for providers:\n${missing.join('\n')}\n\n` +
          `Please set the required environment variables before deploying.`
      );
    }
  }
}
