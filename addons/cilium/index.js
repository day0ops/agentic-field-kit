import { AddonFeature } from '../../src/lib/feature.js';
import { KubernetesHelper, CommandRunner } from '../../src/lib/common.js';
import yaml from 'js-yaml';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_DIR = join(__dirname, 'config');

const DEFAULT_CILIUM_VERSION = '1.19.1';
const CILIUM_HELM_REPO = 'https://helm.cilium.io';
const RELEASE_NAME = 'cilium';
const CILIUM_NAMESPACE = 'kube-system';
const VALID_MODES = ['chaining', 'primary'];

/**
 * Installs Cilium CNI + Hubble for use with Istio Ambient: agent DaemonSet, operator,
 * Hubble relay/UI (when enableHubble), and a health-probe CiliumClusterwideNetworkPolicy
 * (when enableHealthProbePolicy).
 * https://istio.io/latest/docs/ambient/install/platform-prerequisites/#cilium
 * https://docs.cilium.io/en/stable/installation/k8s-install-helm/
 */
export class CiliumFeature extends AddonFeature {
  constructor(name, config) {
    super(name, config);
    this.ciliumNamespace = CILIUM_NAMESPACE;
    this.chartVersion = config.version || DEFAULT_CILIUM_VERSION;
    this.mode = config.mode || 'chaining';
    // CNI to chain with (chaining mode only): aws-cni=EKS, generic-veth=AKS, none=GKE. Default aws-cni.
    this.chainingTarget = config.chainingTarget || 'aws-cni';
    this.hubbleEnabled = config.enableHubble === true;
    this.healthProbePolicyEnabled = config.enableHealthProbePolicy !== false;
    this.ipv6Enabled = !!config.enableIPv6;
    this.userValues = config.values || {};
    this.kubeContext = config.kubeContext || null;
  }

  validate() {
    if (!VALID_MODES.includes(this.mode)) {
      this.log(
        `Invalid Cilium mode: ${this.mode}. Valid values: ${VALID_MODES.join(', ')}`,
        'error'
      );
      return false;
    }
    return true;
  }

  async deploy() {
    this.log(`Installing Cilium ${this.chartVersion} (mode: ${this.mode})...`, 'info');

    await this.addHelmRepo();
    await this.installCilium();
    await this.waitForCilium();

    if (this.healthProbePolicyEnabled) {
      await this.applyHealthProbePolicy();
    }

    const hints = [];
    if (this.hubbleEnabled) {
      hints.push(
        `Hubble UI: kubectl port-forward -n ${this.ciliumNamespace} svc/hubble-ui 12000:80`
      );
    }
    this.log(
      `Cilium installed successfully.${hints.length ? ' ' + hints.join(' | ') : ''}`,
      'success'
    );
  }

  async addHelmRepo() {
    this.log('Adding Cilium Helm repository...', 'info');

    try {
      await CommandRunner.run('helm', ['repo', 'add', 'cilium', CILIUM_HELM_REPO], {
        ignoreError: true,
      });
      await CommandRunner.run('helm', ['repo', 'update', 'cilium']);
      this.log('Cilium Helm repository added and updated', 'info');
    } catch (error) {
      throw new Error(`Failed to add Cilium Helm repository: ${error.message}`);
    }
  }

  /** Install Cilium via Helm. Values layered: base → mode → IPv6 → Hubble → user overrides. */
  async installCilium() {
    this.log('Installing Cilium Helm chart...', 'info');

    const helmArgs = [
      'upgrade',
      '-i',
      RELEASE_NAME,
      'cilium/cilium',
      '-n',
      this.ciliumNamespace,
      '--version',
      this.chartVersion,
      '-f',
      join(CONFIG_DIR, 'values.yaml'),
    ];

    if (this.mode === 'primary') {
      helmArgs.push('-f', join(CONFIG_DIR, 'values-primary.yaml'));
    }

    if (this.mode === 'chaining' && this.chainingTarget !== 'aws-cni') {
      // Override the default aws-cni chaining target from values.yaml
      helmArgs.push('--set', `cni.chainingMode=${this.chainingTarget}`);
    }

    if (this.ipv6Enabled) {
      helmArgs.push('-f', join(CONFIG_DIR, 'values-ipv6.yaml'));
    }

    helmArgs.push(
      '--set',
      `hubble.enabled=${this.hubbleEnabled}`,
      '--set',
      `hubble.relay.enabled=${this.hubbleEnabled}`,
      '--set',
      `hubble.ui.enabled=${this.hubbleEnabled}`
    );

    let userValuesFile = null;
    if (Object.keys(this.userValues).length > 0) {
      userValuesFile = join(tmpdir(), `.agentic-cilium-values-${process.pid}.yaml`);
      writeFileSync(userValuesFile, yaml.dump(this.userValues, { lineWidth: -1 }));
      helmArgs.push('-f', userValuesFile);
    }

    if (this.kubeContext) {
      helmArgs.push('--kube-context', this.kubeContext);
    }

    helmArgs.push('--create-namespace', '--wait', '--timeout', '10m');

    try {
      await KubernetesHelper.helm(helmArgs, this.spinner);
      await KubernetesHelper.assertHelmDeployed(
        RELEASE_NAME,
        this.ciliumNamespace,
        this.kubeContext
      );
      this.log('Cilium Helm chart installed', 'info');
    } finally {
      if (userValuesFile && existsSync(userValuesFile)) {
        try {
          unlinkSync(userValuesFile);
        } catch {
          /* best effort */
        }
      }
    }
  }

  async waitForCilium() {
    this.log('Waiting for Cilium to be ready...', 'info');
    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];

    try {
      await KubernetesHelper.kubectl(
        [
          ...ctxArgs,
          'rollout',
          'status',
          'daemonset/cilium',
          '-n',
          this.ciliumNamespace,
          '--timeout=300s',
        ],
        { ignoreError: true }
      );
      this.log('Cilium agent daemonset is ready', 'info');
    } catch (error) {
      this.log(`Cilium agent daemonset may not be ready: ${error.message}`, 'warn');
    }

    try {
      await KubernetesHelper.waitForDeployment(
        this.ciliumNamespace,
        'cilium-operator',
        300,
        this.spinner,
        this.kubeContext
      );
    } catch (error) {
      this.log(`Cilium operator may not be ready: ${error.message}`, 'warn');
    }

    if (this.hubbleEnabled) {
      try {
        await KubernetesHelper.waitForDeployment(
          this.ciliumNamespace,
          'hubble-relay',
          300,
          this.spinner,
          this.kubeContext
        );
      } catch (error) {
        this.log(`Hubble relay may not be ready: ${error.message}`, 'warn');
      }

      try {
        await KubernetesHelper.waitForDeployment(
          this.ciliumNamespace,
          'hubble-ui',
          300,
          this.spinner,
          this.kubeContext
        );
      } catch (error) {
        this.log(`Hubble UI may not be ready: ${error.message}`, 'warn');
      }
    }

    this.log('Cilium is ready', 'info');
  }

  /**
   * Apply CiliumClusterwideNetworkPolicy allowing SNAT-ed kubelet health probes into
   * ambient pods. Required when default-deny NetworkPolicies are in use.
   * https://istio.io/latest/docs/ambient/install/platform-prerequisites/#cilium
   */
  async applyHealthProbePolicy() {
    this.log('Applying CiliumClusterwideNetworkPolicy for ambient health probes...', 'info');

    const policyFile = join(CONFIG_DIR, 'allow-ambient-hostprobes.yaml');
    try {
      const content = readFileSync(policyFile, 'utf8');
      await this.applyYaml(content, this.kubeContext);
      this.log('Health probe policy applied', 'info');
    } catch (error) {
      this.log(`Could not apply health probe policy: ${error.message}`, 'warn');
    }
  }

  async cleanup() {
    this.log('Cleaning up Cilium...', 'info');
    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];

    // CRD may not exist on all clusters, treat as optional
    try {
      await KubernetesHelper.kubectl([
        ...ctxArgs,
        'delete',
        'ciliumclusterwidenetworkpolicy',
        'allow-ambient-hostprobes',
        '--ignore-not-found=true',
      ]);
    } catch (err) {
      if (!/doesn't have a resource type|no kind is registered/i.test(err.message)) {
        this.log(`Could not remove health probe policy (may not exist): ${err.message}`, 'warn');
      }
    }

    // cni.uninstall=true triggers the agent's pre-stop hook to remove CNI config and
    // binaries from each node before uninstall. Best-effort: if the release is gone, continue.
    try {
      this.log('Enabling CNI cleanup on Cilium agents...', 'info');
      await CommandRunner.run('helm', [
        ...helmCtxArgs,
        'upgrade',
        RELEASE_NAME,
        'cilium/cilium',
        '-n',
        this.ciliumNamespace,
        '--reuse-values',
        '--set',
        'cni.uninstall=true',
        '--wait',
        '--timeout',
        '5m',
      ]);
    } catch {
      // best-effort: ignore failures and proceed to uninstall
    }

    try {
      await CommandRunner.run('helm', [
        ...helmCtxArgs,
        'uninstall',
        RELEASE_NAME,
        '-n',
        this.ciliumNamespace,
        '--wait',
      ]);
      this.log('Cilium Helm release uninstalled', 'info');
    } catch (err) {
      if (!/not found|no deployed releases/i.test(err.message)) throw err;
    }

    this.log('Cilium cleaned up', 'success');
  }
}
