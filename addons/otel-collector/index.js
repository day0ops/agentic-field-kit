import { AddonFeature } from '../../src/lib/feature.js';
import { KubernetesHelper, CommandRunner } from '../../src/lib/common.js';
import yaml from 'js-yaml';
import { join } from 'path';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';

const DEFAULT_CHART_VERSION = '0.158.0';
const OTEL_HELM_REPO = 'https://open-telemetry.github.io/opentelemetry-helm-charts';
const RELEASE_NAME = 'otel-collector';

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
 * Deliberately narrower than the `telemetry` addon: no Grafana/Tempo/Loki/Prometheus,
 * just enough to unblock kagent's own dashboards (worker pool occupancy, chat spans).
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
    // Matches the kagent-enterprise chart's own default (enterprise.database.clickhouse.*);
    // override here if that chart's password was changed from its default.
    this.clickhouseUsername = config.clickhouseUsername || 'default';
    this.clickhousePassword = config.clickhousePassword || 'password';
    // Matches the kagent-ui chart's own default (EXTENSION_LOCAL_CLUSTER_NAME) --
    // override here if that chart's cluster name was changed from its default.
    this.clusterName = config.clusterName || 'mgmt-cluster';
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

  async deploy() {
    this.log(`Installing OTel Collector ${this.chartVersion} (ClickHouse exporter)...`, 'info');

    await this.addHelmRepo();
    await this.installCollector();
    await this.waitForCollector();

    this.log(
      `OTel Collector installed successfully. Endpoint: ${this.endpoint}`,
      'success'
    );
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
    const clickhouseEndpoint = `tcp://${this.clickhouseUsername}:${this.clickhousePassword}@${this.clickhouseHost}:${this.clickhousePort}?database=${this.clickhouseDatabase}`;
    const genaiEndpoint = `${clickhouseEndpoint}&dial_timeout=10s&enable_json_type=1`;

    return {
      mode: 'deployment',
      replicaCount: 1,
      image: {
        repository: 'ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib',
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
        },
        service: {
          pipelines: {
            traces: {
              receivers: ['otlp'],
              processors: ['resource/cluster_context', 'batch'],
              exporters: ['clickhouse/genai'],
            },
            metrics: {
              receivers: ['otlp'],
              processors: ['resource/cluster_context', 'batch'],
              exporters: ['clickhouse'],
            },
            logs: {
              receivers: ['otlp'],
              processors: ['resource/cluster_context', 'batch'],
              exporters: ['clickhouse/genai'],
            },
          },
        },
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

  async cleanup() {
    this.log('Cleaning up OTel Collector...', 'info');
    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];

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
