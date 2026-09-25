import path from 'path';
import { fileURLToPath } from 'url';
import { AddonFeature } from '../../src/lib/feature.js';
import {
  KubernetesHelper,
  CommandRunner,
  nlbSourceRangeAnnotations,
} from '../../src/lib/common.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(__dirname, 'config');

const OSS_VERSION = 'v1.2.0';
const ENTERPRISE_VERSION = 'v2.2.0';
const DEFAULT_GATEWAY_API_VERSION = 'v1.5.0';
const OSS_REGISTRY = 'oci://cr.agentgateway.dev/charts';
const ENTERPRISE_REGISTRY = 'oci://us-docker.pkg.dev/solo-public/enterprise-agentgateway/charts';

export class AgentgatewayFeature extends AddonFeature {
  constructor(name, config = {}) {
    super(name, config);
    this.enterprise = config.enterprise === true;
    this.namespace = config.namespace || 'agentgateway-system';
    this.version = config.version || (this.enterprise ? ENTERPRISE_VERSION : OSS_VERSION);
    this.gatewayApiVersion = config.gatewayApiVersion || DEFAULT_GATEWAY_API_VERSION;
    this.registry = this.enterprise ? ENTERPRISE_REGISTRY : OSS_REGISTRY;
    this.crdsRelease = this.enterprise ? 'enterprise-agentgateway-crds' : 'agentgateway-crds';
    this.mainRelease = this.enterprise ? 'enterprise-agentgateway' : 'agentgateway';
    this.kubeContext = config.kubeContext || null;
    this.clusterName = config.clusterName || null;
    this.gateway = config.gateway || null;
    this.soloUiNamespace = config.soloUiNamespace || null;
    this.telemetryGatewayName = config.telemetryGatewayName || config.gateway?.name || null;
    this.telemetryGatewayNamespace =
      config.telemetryGatewayNamespace || config.gateway?.namespace || this.namespace;
    this.ambientEnabled = config.ambientEnabled === true;
    this.globalGateway = config.globalGateway === true;
    this.gatewayServiceType = config.gateway?.serviceType || null;
    this.gatewaySourceRanges = config.gateway?.sourceRanges || null;
    // A real (non-mTLS) HTTPS listener with a cert-manager-issued cert -- see
    // agentgateway-field-kit's gateway-mtls addon for the pattern this mirrors. Needed
    // by anything that requires a genuine TLS token endpoint (e.g. tokenExchange's
    // advertised issuer/token_endpoint), since this Gateway otherwise only has a plain
    // HTTP listener.
    this.publicHttps = config.gateway?.publicHttps?.enabled ? config.gateway.publicHttps : null;
    // Extra, explicitly-named HTTP listeners on the same port -- e.g. this Service's own
    // in-cluster DNS name, so callers already inside the cluster can reach it directly
    // (avoiding a hairpin through the external LB for the primary hostname, confirmed live
    // to reliably take ~4.5 minutes to connect or time out) without loosening the primary
    // listener's own Host-header restriction. HTTPRoutes with no hostnames of their own
    // already match every listener on this Gateway, so no HTTPRoute changes are needed.
    this.additionalHostnames = config.gateway?.additionalHostnames || [];
    this.tracesCollectorName = config.tracesCollectorName || 'opentelemetry-collector-traces';
    this.tracesCollectorNamespace = config.tracesCollectorNamespace || 'telemetry';
    this.tracingRandomSampling = config.tracingRandomSampling !== false ? 'true' : 'false';
    // Enables the controller's token-exchange/elicitation STS (chart default: disabled).
    // jwtIssuer must be a real per-environment URL, so it's templated addon config here
    // rather than a static values.yaml entry.
    this.tokenExchange = config.tokenExchange?.enabled
      ? {
          issuer: config.tokenExchange.issuer,
          jwtIssuer: config.tokenExchange.jwtIssuer,
          jwksPath: config.tokenExchange.jwksPath || '/protocol/openid-connect/certs',
          // /elicitations is also called by solo-ui's ui-backend, forwarding the browser's
          // own session JWT (a different Keycloak realm than jwtIssuer's customer realm) when
          // proxying /api/proxy/cluster/<cluster>/gg/* -- these issuers get their own
          // apiValidators entries alongside jwtIssuer's (see buildTokenExchangeHelmArgs).
          additionalApiValidatorIssuers: config.tokenExchange.additionalApiValidatorIssuers || [],
        }
      : null;
  }

  validate() {
    if (this.enterprise && !process.env.ENTERPRISE_AGENTGATEWAY_LICENSE) {
      throw new Error(
        'ENTERPRISE_AGENTGATEWAY_LICENSE environment variable is required for agentgateway Enterprise'
      );
    }
    if (this.tokenExchange && (!this.tokenExchange.issuer || !this.tokenExchange.jwtIssuer)) {
      throw new Error(
        'tokenExchange.enabled requires tokenExchange.issuer and tokenExchange.jwtIssuer to also be set'
      );
    }
    return true;
  }

  async deploy() {
    const licenseKey = this.enterprise ? process.env.ENTERPRISE_AGENTGATEWAY_LICENSE : undefined;

    const mode = this.enterprise ? 'Enterprise' : 'OSS';
    this.log(`Installing agentgateway ${mode} ${this.version}`);

    const kubectlCtxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];

    this.log(`Installing Gateway API CRDs ${this.gatewayApiVersion}`);
    await KubernetesHelper.kubectl([
      ...kubectlCtxArgs,
      'apply',
      '--server-side',
      '--force-conflicts',
      '-f',
      `https://github.com/kubernetes-sigs/gateway-api/releases/download/${this.gatewayApiVersion}/standard-install.yaml`,
    ]);

    if (this.ambientEnabled) {
      await KubernetesHelper.ensureNamespace(this.namespace, this.spinner, this.kubeContext);
      await KubernetesHelper.labelNamespaceForAmbient(this.namespace, this.kubeContext, {
        quiet: true,
      });
      this.log(`Namespace '${this.namespace}' labeled for Ambient mode`);
    }

    this.log('Installing agentgateway CRDs');
    await KubernetesHelper.helm(
      [
        'upgrade',
        '-i',
        this.crdsRelease,
        `${this.registry}/${this.crdsRelease}`,
        '-n',
        this.namespace,
        '--create-namespace',
        '--version',
        this.version,
        '--wait',
        ...helmCtxArgs,
      ],
      { spinner: this.spinner }
    );

    this.log('Installing agentgateway controller');
    const mainArgs = [
      'upgrade',
      '-i',
      this.mainRelease,
      `${this.registry}/${this.mainRelease}`,
      '-n',
      this.namespace,
      '--version',
      this.version,
      '--wait',
      '--timeout',
      '5m',
      '--values',
      path.join(CONFIG_DIR, 'values.yaml'),
      ...helmCtxArgs,
    ];
    if (this.enterprise) {
      mainArgs.push('--set-string', `licensing.licenseKey=${licenseKey}`);
    }
    if (this.enterprise && this.clusterName) {
      // Both default to "" in the chart, so waypoint pods never get CLUSTER_ID/NETWORK env
      // vars -- breaks CSR auth to istiod and Service-VIP lookup respectively. Confirmed live.
      mainArgs.push('--set-string', `istio.clusterId=${this.clusterName}`);
      mainArgs.push('--set-string', `istio.network=${this.clusterName}`);
    }
    if (this.tokenExchange) {
      mainArgs.push(...this.buildTokenExchangeHelmArgs());
    }
    await KubernetesHelper.helm(mainArgs, { spinner: this.spinner });
    await KubernetesHelper.assertHelmDeployed(this.mainRelease, this.namespace, this.kubeContext);

    await KubernetesHelper.waitForDeployment(
      this.namespace,
      this.mainRelease,
      120,
      this.spinner,
      this.kubeContext
    );

    if (this.gateway) {
      // Ensure the namespace exists before anything gets applied into it (the Certificate
      // below, then the Gateway resource itself) -- on a fresh cluster it doesn't exist yet.
      await this.ensureGatewayNamespace();
    }

    if (this.gateway && this.publicHttps) {
      await this.deployPublicHttpsCertificate();
    }

    if (this.gateway) {
      const gatewayClassName = this.enterprise ? 'enterprise-agentgateway' : 'agentgateway';
      await this.createGatewayResource(gatewayClassName);
    }

    if (this.telemetryGatewayName && this.soloUiNamespace) {
      if (this.enterprise) {
        await this.applyTelemetryPolicies();
      } else {
        this.log(
          'Skipping OTel telemetry policies — EnterpriseAgentgatewayPolicy requires agentgateway Enterprise',
          'warn'
        );
      }
    }

    // Disable Istio mesh tracing here; agentgateway does its own tracing via
    // EnterpriseAgentgatewayPolicy, avoiding duplicate spans in Tempo.
    await this.applyResource(
      {
        apiVersion: 'telemetry.istio.io/v1',
        kind: 'Telemetry',
        metadata: {
          name: 'disable-mesh-tracing',
          namespace: this.namespace,
          labels: {
            'app.kubernetes.io/managed-by': 'agentic-demo',
            'agentic.demo/feature': 'agentgateway',
          },
        },
        spec: {
          tracing: [{ disableSpanReporting: true }],
        },
      },
      this.kubeContext
    );

    if (this.gateway) {
      await this.applyResource(
        {
          apiVersion: 'telemetry.istio.io/v1',
          kind: 'Telemetry',
          metadata: {
            name: 'disable-mesh-tracing',
            namespace: this.telemetryGatewayNamespace,
            labels: {
              'app.kubernetes.io/managed-by': 'agentic-demo',
              'agentic.demo/feature': 'agentgateway',
            },
          },
          spec: {
            tracing: [{ disableSpanReporting: true }],
          },
        },
        this.kubeContext
      );
    }

    this.log(`agentgateway ${mode} installed successfully`, 'success');
  }

  get publicHttpsCertName() {
    return this.publicHttps?.certSecretName || `${this.gateway.name}-public-tls`;
  }

  async deployPublicHttpsCertificate() {
    const secretName = this.publicHttpsCertName;
    const issuerName = this.publicHttps.issuer || 'letsencrypt-dns';
    const dnsNames = this.publicHttps.dnsNames || [this.gateway.hostname];
    this.log(`Provisioning public HTTPS certificate '${secretName}' (issuer: ${issuerName})...`);
    await this.applyResource(
      {
        apiVersion: 'cert-manager.io/v1',
        kind: 'Certificate',
        metadata: { name: secretName, namespace: this.gateway.namespace },
        spec: {
          secretName,
          issuerRef: { name: issuerName, kind: 'ClusterIssuer' },
          dnsNames,
        },
      },
      this.kubeContext
    );
    await this.waitForCertificate(this.gateway.namespace, secretName);
  }

  async waitForCertificate(namespace, name) {
    this.log(`Waiting for TLS certificate '${name}' to be ready...`, 'info');
    const maxAttempts = 60;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const result = await KubernetesHelper.kubectl([
          ...(this.kubeContext ? [`--context=${this.kubeContext}`] : []),
          'get',
          'certificate',
          name,
          '-n',
          namespace,
          '-o',
          'jsonpath={.status.conditions[?(@.type=="Ready")].status}',
        ]);
        if (result?.stdout?.trim() === 'True') {
          this.log(`Certificate '${name}' is ready`, 'info');
          return;
        }
      } catch {
        // certificate may not exist yet
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    this.log(`Certificate '${name}' may not be fully ready yet, proceeding...`, 'warn');
  }

  // Against a live v2026.8.2 controller, tokenExchange.enabled alone fails at startup with
  // "issuer is required" / "error creating actor validator: at least one validator is
  // required" (undocumented in the chart). actorValidators is unused by this flow but still
  // needs >=1 entry; a k8s validator satisfies it via the cluster API server, no external IdP.
  buildTokenExchangeHelmArgs() {
    const validatorFor = issuer => ({
      validatorType: 'remote',
      remoteConfig: { url: `${issuer}${this.tokenExchange.jwksPath}` },
      issuer,
    });
    const subjectValidators = JSON.stringify([validatorFor(this.tokenExchange.jwtIssuer)]);
    // apiValidators (not subjectValidators) also needs solo-ui's realm -- confirmed live: a
    // valid JWT from a realm not in this list gets a clean 401 from /elicitations.
    const apiValidators = JSON.stringify([
      validatorFor(this.tokenExchange.jwtIssuer),
      ...this.tokenExchange.additionalApiValidatorIssuers.map(validatorFor),
    ]);
    const actorValidators = JSON.stringify([{ validatorType: 'k8s' }]);
    return [
      '--set',
      'tokenExchange.enabled=true',
      '--set-string',
      `tokenExchange.issuer=${this.tokenExchange.issuer}`,
      '--set-json',
      `tokenExchange.subjectValidators=${subjectValidators}`,
      '--set-json',
      `tokenExchange.apiValidators=${apiValidators}`,
      '--set-json',
      `tokenExchange.actorValidators=${actorValidators}`,
    ];
  }

  buildGatewayResource(gatewayClassName) {
    const hostname = this.gateway.hostname;
    const port = this.gateway.port || 80;
    const protocol = this.gateway.protocol || 'HTTP';

    let listeners;
    if (this.gateway.listeners) {
      listeners = this.gateway.listeners;
    } else {
      const allowedRoutes = this.gateway.allowedRoutes || { namespaces: { from: 'Same' } };
      const httpListener = { name: 'http', port, protocol, allowedRoutes };
      if (hostname) httpListener.hostname = hostname;
      listeners = [httpListener];

      this.additionalHostnames.forEach((altHostname, i) => {
        listeners.push({
          name: `http-alt-${i}`,
          port,
          protocol,
          hostname: altHostname,
          allowedRoutes,
        });
      });
    }

    if (this.publicHttps) {
      const httpsPort = this.publicHttps.port || 443;
      const httpsHostname = this.publicHttps.dnsNames?.[0] || hostname;
      const httpsListener = {
        name: 'https',
        port: httpsPort,
        protocol: 'HTTPS',
        tls: {
          mode: 'Terminate',
          certificateRefs: [{ name: this.publicHttpsCertName, kind: 'Secret' }],
        },
        allowedRoutes: this.gateway.allowedRoutes || { namespaces: { from: 'Same' } },
      };
      if (httpsHostname) httpsListener.hostname = httpsHostname;
      listeners.push(httpsListener);
    }

    const spec = { gatewayClassName, listeners };
    if (this.ambientEnabled || this.gatewayServiceType || this.gatewaySourceRanges) {
      spec.infrastructure = {};
      if (this.ambientEnabled) {
        spec.infrastructure.annotations = { 'ambient.istio.io/bypass-inbound-capture': 'true' };
      }
      if (this.gatewayServiceType || this.gatewaySourceRanges) {
        const paramsGroup = this.enterprise ? 'enterpriseagentgateway.solo.io' : 'agentgateway.dev';
        const paramsKind = this.enterprise
          ? 'EnterpriseAgentgatewayParameters'
          : 'AgentgatewayParameters';
        spec.infrastructure.parametersRef = {
          name: `${this.gateway.name}-params`,
          group: paramsGroup,
          kind: paramsKind,
        };
      }
    }

    return {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'Gateway',
      metadata: {
        name: this.gateway.name,
        namespace: this.gateway.namespace,
      },
      spec,
    };
  }

  async ensureGatewayNamespace() {
    const namespace = this.gateway.namespace;
    const ctxFlag = this.kubeContext ? `--context=${this.kubeContext}` : '';
    await CommandRunner.exec(
      `kubectl ${ctxFlag} create namespace ${namespace} --dry-run=client -o yaml | kubectl ${ctxFlag} apply -f -`,
      { ignoreError: true }
    );

    if (this.ambientEnabled) {
      await KubernetesHelper.labelNamespaceForAmbient(namespace, this.kubeContext, { quiet: true });
      this.log(`Namespace '${namespace}' labeled for Ambient mode`);
    }
  }

  async createGatewayResource(gatewayClassName) {
    const name = this.gateway.name;
    const namespace = this.gateway.namespace;
    this.log(`Creating Gateway "${name}" (class: ${gatewayClassName}, namespace: ${namespace})`);

    const kubectlCtxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    await this.ensureGatewayNamespace();

    if (this.gatewayServiceType || this.gatewaySourceRanges) {
      const paramsApiVersion = this.enterprise
        ? 'enterpriseagentgateway.solo.io/v1alpha1'
        : 'agentgateway.dev/v1alpha1';
      const paramsKind = this.enterprise
        ? 'EnterpriseAgentgatewayParameters'
        : 'AgentgatewayParameters';
      const nlbAnnotations = nlbSourceRangeAnnotations(this.gatewaySourceRanges);
      const service = {};
      if (this.gatewayServiceType) {
        service.spec = { type: this.gatewayServiceType };
      }
      if (nlbAnnotations) {
        service.metadata = { annotations: nlbAnnotations };
      }
      await this.applyResource(
        {
          apiVersion: paramsApiVersion,
          kind: paramsKind,
          metadata: { name: `${name}-params`, namespace },
          spec: { service },
        },
        this.kubeContext
      );
      const details = [
        this.gatewayServiceType && `service type: ${this.gatewayServiceType}`,
        nlbAnnotations && 'NLB source-range annotations',
      ]
        .filter(Boolean)
        .join(', ');
      this.log(`Gateway parameters '${name}-params' applied (${details})`);
    }

    const resource = this.buildGatewayResource(gatewayClassName);
    await this.applyResource(resource, this.kubeContext);

    if (this.globalGateway) {
      await this.waitForGateway(name, namespace, 120, this.kubeContext);
      await KubernetesHelper.kubectl([
        ...kubectlCtxArgs,
        'label',
        'service',
        name,
        '-n',
        namespace,
        'solo.io/service-scope=global',
        '--overwrite',
      ]);
      this.log(`Gateway service "${name}" labeled as global`, 'success');
    }

    this.log(`Gateway "${name}" created`, 'success');
  }

  async applyTelemetryPolicies() {
    this.log(
      `Applying OTel telemetry policies for gateway '${this.telemetryGatewayName}'...`,
      'info'
    );
    const gatewayName = this.telemetryGatewayName;
    const gatewayNs = this.telemetryGatewayNamespace;

    // EnterpriseAgentgatewayPolicy: tracing → OTel traces collector
    await this.applyResource(
      {
        apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
        kind: 'EnterpriseAgentgatewayPolicy',
        metadata: { name: 'otel-tracing-policy', namespace: gatewayNs },
        spec: {
          targetRefs: [{ group: 'gateway.networking.k8s.io', kind: 'Gateway', name: gatewayName }],
          frontend: {
            tracing: {
              backendRef: {
                name: this.tracesCollectorName,
                namespace: this.tracesCollectorNamespace,
                port: 4317,
              },
              protocol: 'GRPC',
              randomSampling: this.tracingRandomSampling,
              attributes: {
                add: [
                  {
                    name: 'user.id',
                    expression: 'coalesce(jwt.sub, request.headers["x-user-id"])',
                  },
                ],
              },
            },
          },
        },
      },
      this.kubeContext
    );

    // EnterpriseAgentgatewayPolicy: access log → OTel logs collector (fan-out to Loki + Solo UI)
    await this.applyResource(
      {
        apiVersion: 'enterpriseagentgateway.solo.io/v1alpha1',
        kind: 'EnterpriseAgentgatewayPolicy',
        metadata: { name: 'otel-access-log-policy', namespace: gatewayNs },
        spec: {
          targetRefs: [{ group: 'gateway.networking.k8s.io', kind: 'Gateway', name: gatewayName }],
          frontend: {
            accessLog: {
              otlp: {
                backendRef: {
                  name: this.logsCollectorName || 'opentelemetry-collector-logs',
                  namespace: this.tracesCollectorNamespace,
                  port: 4317,
                },
              },
              attributes: {
                add: [
                  { name: 'http.user_agent', expression: 'request.headers["user-agent"]' },
                  { name: 'http.method', expression: 'request.method' },
                  { name: 'http.path', expression: 'request.path' },
                  { name: 'http.host', expression: 'request.host' },
                  { name: 'http.status_code', expression: 'string(response.code)' },
                  { name: 'http.scheme', expression: 'request.scheme' },
                  {
                    name: 'request.start_time',
                    expression: 'default(string(request.startTime), "")',
                  },
                  { name: 'request.end_time', expression: 'default(string(request.endTime), "")' },
                  { name: 'source.address', expression: 'source.address' },
                  { name: 'backend.name', expression: 'default(backend.name, "")' },
                  { name: 'llm.input_tokens', expression: 'default(string(llm.inputTokens), "0")' },
                  {
                    name: 'llm.output_tokens',
                    expression: 'default(string(llm.outputTokens), "0")',
                  },
                  { name: 'llm.total_tokens', expression: 'default(string(llm.totalTokens), "0")' },
                  { name: 'llm.request_model', expression: 'default(llm.requestModel, "")' },
                  { name: 'llm.response_model', expression: 'default(llm.responseModel, "")' },
                  { name: 'extproc_metadata', expression: 'default(toJson(extproc), "{}")' },
                  { name: 'mcp.tool.name', expression: 'default(mcp.tool.name, "")' },
                  { name: 'mcp.tool.target', expression: 'default(mcp.tool.target, "")' },
                  { name: 'mcp.prompt.name', expression: 'default(mcp.prompt.name, "")' },
                  { name: 'mcp.prompt.target', expression: 'default(mcp.prompt.target, "")' },
                  { name: 'mcp.resource.name', expression: 'default(mcp.resource.name, "")' },
                  { name: 'mcp.resource.target', expression: 'default(mcp.resource.target, "")' },
                ],
              },
            },
          },
        },
      },
      this.kubeContext
    );

    this.log('OTel telemetry policies applied', 'info');
  }

  async cleanup() {
    this.log('Removing agentgateway');
    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];
    const kubectlCtxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];

    if (this.gateway) {
      if (this.globalGateway) {
        try {
          await KubernetesHelper.kubectl([
            ...kubectlCtxArgs,
            'label',
            'service',
            this.gateway.name,
            '-n',
            this.gateway.namespace,
            'solo.io/service-scope-',
            '--ignore-not-found=true',
          ]);
        } catch {
          /* best effort */
        }
      }
      await this.deleteResource(
        'gateway',
        this.gateway.name,
        this.gateway.namespace,
        this.kubeContext
      );
      if (this.gatewayServiceType) {
        const paramsKind = this.enterprise
          ? 'enterpriseagentgatewayparameters'
          : 'agentgatewayparameters';
        await this.deleteResource(
          paramsKind,
          `${this.gateway.name}-params`,
          this.gateway.namespace,
          this.kubeContext
        );
      }
      if (this.publicHttps) {
        await this.deleteResource(
          'certificate',
          this.publicHttpsCertName,
          this.gateway.namespace,
          this.kubeContext
        );
        await this.deleteResource(
          'secret',
          this.publicHttpsCertName,
          this.gateway.namespace,
          this.kubeContext
        );
      }
    }

    if (this.telemetryGatewayName && this.soloUiNamespace && this.enterprise) {
      const gatewayNs = this.telemetryGatewayNamespace;
      for (const name of ['otel-tracing-policy', 'otel-access-log-policy']) {
        await this.deleteResource(
          'enterpriseagentgatewaypolicy',
          name,
          gatewayNs,
          this.kubeContext
        );
      }
    }

    for (const release of [this.mainRelease, this.crdsRelease]) {
      try {
        await KubernetesHelper.helm(['uninstall', release, '-n', this.namespace, ...helmCtxArgs], {
          spinner: this.spinner,
        });
      } catch (err) {
        if (!/not found|no deployed releases/i.test(err.message)) throw err;
      }
    }
    await KubernetesHelper.kubectl([
      ...kubectlCtxArgs,
      'delete',
      'namespace',
      this.namespace,
      '--ignore-not-found=true',
    ]);
    if (this.gateway && this.gateway.namespace !== this.namespace) {
      await KubernetesHelper.kubectl([
        ...kubectlCtxArgs,
        'delete',
        'namespace',
        this.gateway.namespace,
        '--ignore-not-found=true',
      ]);
    }
    this.log('agentgateway removed', 'success');
  }
}
