import { AddonFeature } from '../../src/lib/feature.js';
import { KubernetesHelper, CommandRunner } from '../../src/lib/common.js';
import yaml from 'js-yaml';
import { join } from 'path';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';

const DEFAULT_CHART_VERSION = '0.158.0';
const OTEL_HELM_REPO = 'https://open-telemetry.github.io/opentelemetry-helm-charts';
const RELEASE_NAME = 'otel-collector';
const SERVICE_MONITOR_NAME = 'otel-collector-substrate-metrics';
// Keep in sync with addons/kagent/index.js's CLICKHOUSE_CREDENTIALS_SECRET -- this addon
// reads the same Secret the kagent addon generates, rather than assuming chart defaults.
const CLICKHOUSE_CREDENTIALS_SECRET = 'kagent-clickhouse-credentials';

/**
 * Minimal standalone OTel Collector that catches OTLP traces/metrics/logs from
 * kagent-controller and Agent Substrate (both default to localhost:4317, which nothing
 * listens on without this) and forwards them into the kagent-enterprise chart's own
 * bundled ClickHouse instance.
 *
 * Traces/logs use a dedicated `clickhouse/genai` exporter with `json: true` and
 * `enable_json_type=1` on the DSN, writing into `otel_traces_json`/`otel_logs_json` --
 * live-confirmed (2026-09-28) as the exact recipe kagent-enterprise's own management
 * chart uses (charts/management/templates/config-map-telemetry-collector.yaml). Those
 * two tables feed kagent's own materialized views (kagent_chat_spans_mv,
 * substrate_actor_requests_mv), which is what the fraud-ops-console's span source reads.
 * The plain (non-json) `clickhouse` exporter's default table names (otel_traces,
 * otel_logs) are a dead end: nothing downstream reads them, and the views those two
 * feed (kagent_chat_spans, substrate_actor_requests) stay permanently empty despite
 * real spans landing in otel_traces. create_schema stays off for the genai exporter to
 * avoid fighting the schema kagent's own migrations already created for those tables;
 * metrics keep the original exporter/table names unchanged since those already populate
 * correctly as-is.
 *
 * Also fans out a copy of traces to Tempo and metrics to Prometheus for the `telemetry`
 * addon (installed separately) via `otlp/tempo` and `prometheus` exporters, plus a
 * ServiceMonitor so that addon's Prometheus scrapes this collector's `:8889/metrics`.
 * Otherwise deliberately narrower than the `telemetry` addon: no Grafana/Loki, just
 * enough to unblock kagent's own dashboards (worker pool occupancy, chat spans).
 *
 * Stamps a `cluster_name` resource attribute on every signal -- kagent-ui's tracing
 * page filters `ListChatTraces` results client-side by `trace.cluster ===
 * activeCluster.name` (there is no cluster param on the request itself), where
 * `activeCluster.name` is `EXTENSION_LOCAL_CLUSTER_NAME` (default `mgmt-cluster`,
 * live-confirmed 2026-09-28 via the served env-config.js). Without this attribute
 * every trace's Cluster field is empty and never matches, so the page shows "No
 * Traces On This Cluster" regardless of how much real data ClickHouse actually has --
 * live-confirmed as the actual root cause of that exact empty state.
 */
export class OtelCollectorFeature extends AddonFeature {
  constructor(name, config) {
    super(name, config);
    this.chartVersion = config.version || DEFAULT_CHART_VERSION;
    this.clickhouseHost =
      config.clickhouseHost || `kagent-clickhouse.${this.namespace}.svc.cluster.local`;
    this.clickhousePort = config.clickhousePort || 9000;
    this.clickhouseDatabase = config.clickhouseDatabase || 'kagent';
    // Explicit overrides bypass the generated Secret this addon normally reads credentials
    // from at deploy time (see _resolveClickhouseCredentials) -- e.g. for a BYO/external
    // ClickHouse. Left null otherwise so buildValues() can tell "not yet resolved" apart
    // from a real value.
    this.clickhouseUsername = config.clickhouseUsername || null;
    this.clickhousePassword = config.clickhousePassword || null;
    // Matches the kagent-ui chart's own default (EXTENSION_LOCAL_CLUSTER_NAME) --
    // override here if that chart's cluster name was changed from its default.
    this.clusterName = config.clusterName || 'mgmt-cluster';
    // Namespace the `telemetry` addon installs into - used to build Tempo's in-cluster
    // OTLP endpoint. The two addons don't share any other config today.
    this.telemetryNamespace = config.telemetryNamespace || 'telemetry';
    this.kubeContext = config.kubeContext || null;
  }

  /**
   * Cluster-internal OTLP gRPC endpoint other addons (kagent, substrate) point at.
   * The community opentelemetry-collector chart suffixes the Service name with the
   * chart name, not just the release name.
   */
  get endpoint() {
    return `${RELEASE_NAME}-opentelemetry-collector.${this.namespace}.svc.cluster.local:4317`;
  }

  /**
   * Tempo's in-cluster OTLP gRPC endpoint (grafana/tempo-distributed chart, release name
   * "tempo" -- the distributor component is the one with the OTLP receiver, service name
   * suffixed `-distributor` by that chart's own convention).
   */
  get tempoEndpoint() {
    return `tempo-distributor.${this.telemetryNamespace}.svc.cluster.local:4317`;
  }

  async deploy() {
    this.log(`Installing OTel Collector ${this.chartVersion} (ClickHouse exporter)...`, 'info');

    await this._resolveClickhouseCredentials();
    await this.addHelmRepo();
    await this.installCollector();
    await this.waitForCollector();

    try {
      await this.applyServiceMonitor();
    } catch (error) {
      this.log(`Failed to apply ServiceMonitor: ${error.message}`, 'warn');
    }

    this.log(`OTel Collector installed successfully. Endpoint: ${this.endpoint}`, 'success');
  }

  /**
   * Decodes a `kubectl -o jsonpath='{.data.a}|{.data.b}'` result (base64-encoded Secret
   * values, pipe-joined) into [a, b]. Returns null when either half is missing -- the Secret
   * doesn't exist, or doesn't carry both keys.
   */
  _decodeSecretPair(stdout) {
    const trimmed = (stdout || '').trim();
    if (!trimmed.includes('|')) return null;
    const [a, b] = trimmed.split('|');
    if (!a || !b) return null;
    return [Buffer.from(a, 'base64').toString('utf8'), Buffer.from(b, 'base64').toString('utf8')];
  }

  /**
   * Reads the ClickHouse credential the kagent addon generated (see its own
   * CLICKHOUSE_CREDENTIALS_SECRET) from the same namespace this collector installs into --
   * both addons are expected to share a namespace (see this.namespace's doc comment). A
   * no-op when an explicit clickhouseUsername/clickhousePassword override was already given.
   */
  async _resolveClickhouseCredentials() {
    if (this.clickhouseUsername && this.clickhousePassword) return;

    const ctxFlag = this.kubeContext ? `--context=${this.kubeContext}` : '';
    const ctxStr = ctxFlag ? `${ctxFlag} ` : '';
    const result = await CommandRunner.exec(
      `kubectl ${ctxStr}get secret ${CLICKHOUSE_CREDENTIALS_SECRET} -n ${this.namespace} -o jsonpath="{.data.username}|{.data.password}" --ignore-not-found`,
      { ignoreError: true }
    );
    const decoded = !result.exitCode && this._decodeSecretPair(result.stdout);
    if (!decoded) {
      this.log(
        `ClickHouse credentials Secret '${CLICKHOUSE_CREDENTIALS_SECRET}' not found in namespace '${this.namespace}' -- falling back to the chart's own default/password. Deploy the kagent addon (which generates this Secret) first, or set clickhouseUsername/clickhousePassword explicitly.`,
        'warn'
      );
      return;
    }
    [this.clickhouseUsername, this.clickhousePassword] = decoded;
  }

  async addHelmRepo() {
    try {
      await CommandRunner.run('helm', ['repo', 'add', 'open-telemetry', OTEL_HELM_REPO], {
        ignoreError: true,
      });
      await CommandRunner.run('helm', ['repo', 'update', 'open-telemetry']);
      this.log('OpenTelemetry Helm repository added and updated', 'info');
    } catch (error) {
      throw new Error(`Failed to add OpenTelemetry Helm repository: ${error.message}`);
    }
  }

  buildValues() {
    // Falls back to the chart's own default/password only when no explicit override and
    // no resolved Secret exist yet (e.g. called directly, without deploy() having run).
    const username = this.clickhouseUsername || 'default';
    const password = this.clickhousePassword || 'password';
    const clickhouseEndpoint = `tcp://${username}:${password}@${this.clickhouseHost}:${this.clickhousePort}?database=${this.clickhouseDatabase}`;
    const genaiEndpoint = `${clickhouseEndpoint}&dial_timeout=10s&enable_json_type=1`;

    return {
      mode: 'deployment',
      replicaCount: 1,
      image: {
        repository:
          'ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib',
      },
      command: { name: 'otelcol-contrib' },
      config: {
        receivers: {
          otlp: {
            protocols: {
              grpc: { endpoint: '0.0.0.0:4317' },
              http: { endpoint: '0.0.0.0:4318' },
            },
          },
        },
        processors: {
          batch: {},
          'resource/cluster_context': {
            attributes: [{ key: 'cluster_name', action: 'insert', value: this.clusterName }],
          },
        },
        exporters: {
          clickhouse: {
            endpoint: clickhouseEndpoint,
            create_schema: true,
            timeout: '10s',
          },
          'clickhouse/genai': {
            endpoint: genaiEndpoint,
            json: true,
            create_schema: false,
            traces_table_name: 'otel_traces_json',
            logs_table_name: 'otel_logs_json',
            timeout: '10s',
          },
          'otlp/tempo': {
            endpoint: this.tempoEndpoint,
            tls: { insecure: true },
          },
          prometheus: {
            endpoint: '0.0.0.0:8889',
            // Keeps the cluster_name resource attribute (stamped by resource/cluster_context
            // below) as a Prometheus label -- without this the exporter drops resource
            // attributes entirely.
            resource_to_telemetry_conversion: { enabled: true },
          },
        },
        service: {
          pipelines: {
            traces: {
              receivers: ['otlp'],
              processors: ['resource/cluster_context', 'batch'],
              exporters: ['clickhouse/genai', 'otlp/tempo'],
            },
            metrics: {
              receivers: ['otlp'],
              processors: ['resource/cluster_context', 'batch'],
              exporters: ['clickhouse', 'prometheus'],
            },
            logs: {
              receivers: ['otlp'],
              processors: ['resource/cluster_context', 'batch'],
              exporters: ['clickhouse/genai'],
            },
          },
        },
      },
      ports: {
        metrics: { enabled: true, containerPort: 8889, servicePort: 8889, protocol: 'TCP' },
      },
    };
  }

  async installCollector() {
    const helmArgs = [
      'upgrade',
      '-i',
      RELEASE_NAME,
      'open-telemetry/opentelemetry-collector',
      '-n',
      this.namespace,
      '--version',
      this.chartVersion,
      '--create-namespace',
      '--wait',
      '--timeout',
      '5m',
    ];

    const valuesFile = join(tmpdir(), `.agentic-otel-collector-values-${process.pid}.yaml`);
    try {
      writeFileSync(valuesFile, yaml.dump(this.buildValues(), { lineWidth: -1 }));
      helmArgs.push('-f', valuesFile);

      if (this.kubeContext) {
        helmArgs.push('--kube-context', this.kubeContext);
      }

      await KubernetesHelper.helm(helmArgs, { spinner: this.spinner });
      await KubernetesHelper.assertHelmDeployed(RELEASE_NAME, this.namespace, this.kubeContext);
      this.log('OTel Collector Helm chart installed', 'info');
    } finally {
      if (existsSync(valuesFile)) {
        try {
          unlinkSync(valuesFile);
        } catch {
          /* best effort */
        }
      }
    }
  }

  async waitForCollector() {
    try {
      await KubernetesHelper.waitForDeployment(
        this.namespace,
        // The community opentelemetry-collector chart suffixes the Deployment name with
        // the chart name, not just the release name.
        `${RELEASE_NAME}-opentelemetry-collector`,
        300,
        this.spinner,
        this.kubeContext
      );
      this.log('OTel Collector deployment is ready', 'info');
    } catch (error) {
      this.log(`OTel Collector may not be ready: ${error.message}`, 'warn');
    }
  }

  async applyServiceMonitor() {
    await this.applyResource(
      {
        apiVersion: 'monitoring.coreos.com/v1',
        kind: 'ServiceMonitor',
        metadata: { name: SERVICE_MONITOR_NAME, namespace: this.namespace },
        spec: {
          selector: { matchLabels: { 'app.kubernetes.io/instance': RELEASE_NAME } },
          namespaceSelector: { matchNames: [this.namespace] },
          endpoints: [{ port: 'metrics', path: '/metrics', interval: '30s' }],
        },
      },
      this.kubeContext
    );
  }

  async cleanup() {
    this.log('Cleaning up OTel Collector...', 'info');
    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];

    await this.deleteResource(
      'ServiceMonitor',
      SERVICE_MONITOR_NAME,
      this.namespace,
      this.kubeContext
    );

    try {
      await CommandRunner.run('helm', [
        ...helmCtxArgs,
        'uninstall',
        RELEASE_NAME,
        '-n',
        this.namespace,
        '--wait',
      ]);
      this.log('OTel Collector Helm release uninstalled', 'info');
    } catch (err) {
      if (!/not found|no deployed releases/i.test(err.message)) throw err;
    }

    this.log('OTel Collector cleaned up', 'success');
  }
}
