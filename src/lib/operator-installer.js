import yaml from 'js-yaml';
import { CommandRunner, SpinnerLogger } from './common.js';
import { ProfileSchema } from './profile-schema.js';
import { TemplateResolver } from './template-resolver.js';
import { ConfigResolver } from './config-resolver.js';
import { PeeringInstaller } from './multicluster.js';

const DEFAULTS = {
  OPERATOR_NAMESPACE: 'gloo-mesh',
  OPERATOR_VERSION: '0.5.0',
  OPERATOR_REPO: 'us-docker.pkg.dev/solo-public/gloo-operator-helm',
  NAMESPACE: 'istio-system',
  WAIT_TIMEOUT_SEC: 300,
  POLL_INTERVAL_MS: 5000,
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function contextFlags(context) {
  if (!context) return { kubectl: '', helm: '' };
  return {
    kubectl: `--context=${context}`,
    helm: `--kube-context=${context}`,
  };
}

export class OperatorInstaller {
  /**
   * Install mesh on a single cluster using the Gloo Operator.
   *
   * @param {object} options
   * @param {object} options.profile - Loaded profile YAML
   * @param {object} options.cluster - { name, context, role }
   * @param {object} [options.templateContext] - Template resolution context
   * @param {object} options.cfg - Resolved config from installer
   */
  static async installCluster({
    profile,
    cluster,
    templateContext,
    allClusters: _allClusters,
    cfg,
  }) {
    const operatorConfig = ProfileSchema.getOperatorConfig(profile);
    const flags = contextFlags(cluster.context);
    const contextDisplay = cluster.context || 'current context';
    const spinner = new SpinnerLogger();

    const opNamespace = operatorConfig.namespace || DEFAULTS.OPERATOR_NAMESPACE;
    const opVersion = operatorConfig.version || DEFAULTS.OPERATOR_VERSION;
    const opRepo = operatorConfig.image?.repository || DEFAULTS.OPERATOR_REPO;
    const istioNamespace = cfg.namespace || DEFAULTS.NAMESPACE;

    spinner.start(
      `Installing Istio Ambient via Gloo Operator on ${cluster.name} (${contextDisplay})...`
    );

    try {
      spinner.log(`Cluster: ${cluster.name} (role: ${cluster.role || 'default'})`);
      spinner.log(`  INSTALL_METHOD:    operator`);
      spinner.log(`  ISTIO_VERSION:     ${cfg.istioVersion}`);
      spinner.log(`  OPERATOR_VERSION:  ${opVersion}`);
      spinner.log(`  OPERATOR_NS:       ${opNamespace}`);
      spinner.log(`  INSTALL_NS:        ${istioNamespace}`);

      spinner.setText('Installing Gateway API CRDs...');
      await this.#installGatewayApi(cfg, flags, spinner);

      spinner.setText('Installing Gloo Operator...');
      await this.#installOperatorChart(cfg, flags, { opRepo, opVersion, opNamespace }, spinner);

      spinner.setText('Waiting for Gloo Operator pod...');
      await this.#waitForOperatorPod(opNamespace, flags, spinner);

      spinner.setText('Applying ServiceMeshController...');
      await this.#applyServiceMeshController({
        cluster,
        cfg,
        flags,
        opNamespace,
        istioNamespace,
        imageConfig: ProfileSchema.getImageConfig(profile),
        scalingProfile: operatorConfig.scalingProfile,
        smcSpec: ProfileSchema.getServiceMeshControllerSpec(profile),
        templateContext,
        spinner,
      });

      spinner.setText('Waiting for ServiceMeshController to succeed...');
      await this.#waitForControllerReady(opNamespace, flags, spinner);

      const ztunnelEnv = ProfileSchema.getZtunnelEnv(profile);
      if (ztunnelEnv.length > 0) {
        spinner.setText('Patching ztunnel DaemonSet with environment variables...');
        await this.#patchZtunnelEnv(ztunnelEnv, istioNamespace, flags, spinner);
      }

      const resolved = ConfigResolver.resolveForCluster(profile, cluster);
      if (resolved.components.includes('peering-eastwest')) {
        spinner.setText('Deploying east-west gateway...');
        const ewValues = TemplateResolver.resolveValues(
          resolved.componentValues['peering-eastwest'] || {},
          templateContext
        );
        await PeeringInstaller.deployEastWest({
          cluster,
          helmRepo: cfg.helmIstioRepo,
          version: cfg.istioImage,
          componentValues: ewValues,
          flags,
          logger: spinner,
        });
      }

      spinner.succeed(
        `Istio Ambient installed via Gloo Operator on ${cluster.name} (${contextDisplay})`
      );
      return true;
    } catch (error) {
      spinner.fail(`Failed to install via Gloo Operator on ${cluster.name}: ${error.message}`);
      throw error;
    }
  }

  static async uninstall(context = null) {
    const flags = contextFlags(context);
    const opNamespace = DEFAULTS.OPERATOR_NAMESPACE;
    const contextDisplay = context || 'current context';
    const spinner = new SpinnerLogger();

    spinner.start(`Uninstalling Gloo Operator from ${contextDisplay}...`);

    try {
      spinner.setText('Deleting ServiceMeshController...');
      await CommandRunner.exec(
        `kubectl ${flags.kubectl} delete servicemeshcontroller managed-istio -n ${opNamespace} --ignore-not-found=true`,
        { ignoreError: true }
      );

      await this.#waitForSmcDeleted(opNamespace, flags, spinner);

      await CommandRunner.exec(
        `kubectl ${flags.kubectl} delete configmap gloo-extensions-config -n ${opNamespace} --ignore-not-found=true`,
        { ignoreError: true }
      );

      spinner.setText('Uninstalling Gloo Operator Helm chart...');
      try {
        await CommandRunner.exec(`helm ${flags.helm} uninstall gloo-operator -n ${opNamespace}`);
      } catch (err) {
        if (!/not found|no deployed releases/i.test(err.message)) throw err;
      }

      await CommandRunner.exec(
        `kubectl ${flags.kubectl} delete namespace ${opNamespace} --ignore-not-found=true`,
        { ignoreError: true }
      );

      spinner.succeed(`Gloo Operator uninstalled from ${contextDisplay}`);
      return true;
    } catch (error) {
      spinner.fail(`Failed to uninstall Gloo Operator: ${error.message}`);
      throw error;
    }
  }

  static async #waitForSmcDeleted(opNamespace, flags, spinner) {
    const maxAttempts = DEFAULTS.WAIT_TIMEOUT_SEC / (DEFAULTS.POLL_INTERVAL_MS / 1000);

    for (let i = 0; i < maxAttempts; i++) {
      const result = await CommandRunner.exec(
        `kubectl ${flags.kubectl} get servicemeshcontroller managed-istio -n ${opNamespace}`,
        { ignoreError: true }
      );

      if (result.exitCode) {
        spinner.log('ServiceMeshController deleted', 'success');
        return;
      }

      spinner.log('Waiting for ServiceMeshController to be deleted...');
      await sleep(DEFAULTS.POLL_INTERVAL_MS);
    }

    spinner.log('ServiceMeshController may not be fully deleted — proceeding', 'warn');
  }

  static async #installGatewayApi(cfg, flags, spinner) {
    const crdCheck = await CommandRunner.exec(
      `kubectl ${flags.kubectl} get crd gateways.gateway.networking.k8s.io`,
      { ignoreError: true }
    );

    if (!crdCheck.exitCode) {
      spinner.log('Gateway API CRDs already exist, skipping');
      return;
    }

    await CommandRunner.exec(
      `kubectl ${flags.kubectl} apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/${cfg.gatewayApiVersion}/standard-install.yaml`,
      { ignoreError: true }
    );

    await sleep(2000);

    const verifyResult = await CommandRunner.exec(
      `kubectl ${flags.kubectl} get crd gateways.gateway.networking.k8s.io`,
      { ignoreError: true }
    );

    if (verifyResult.exitCode) {
      throw new Error('Failed to install Gateway API CRDs');
    }

    spinner.log('Gateway API CRDs installed', 'success');
  }

  static async #installOperatorChart(cfg, flags, { opRepo, opVersion, opNamespace }, spinner) {
    const helmResult = await CommandRunner.exec(
      `helm ${flags.helm} upgrade --install gloo-operator oci://${opRepo}/gloo-operator ` +
        `--version ${opVersion} ` +
        `-n ${opNamespace} ` +
        `--create-namespace ` +
        `--set manager.env.ENTERPRISE_ISTIO_LICENSE=${cfg.licenseKey} ` +
        `--wait --timeout 5m`,
      { ignoreError: true }
    );

    if (helmResult.exitCode) {
      throw new Error(`Failed to install Gloo Operator: ${helmResult.stderr || helmResult.stdout}`);
    }

    spinner.log('Gloo Operator Helm chart installed', 'success');
  }

  static async #waitForOperatorPod(opNamespace, flags, spinner) {
    for (let i = 0; i < 30; i++) {
      const result = await CommandRunner.exec(
        `kubectl ${flags.kubectl} get pods -n ${opNamespace} -l app.kubernetes.io/name=gloo-operator -o json`,
        { ignoreError: true }
      );

      const stdout = result.stdout || '';
      if (stdout) {
        try {
          const pods = JSON.parse(stdout);
          const running = (pods.items || []).some(
            p => p.status?.phase === 'Running' && p.status?.containerStatuses?.every(c => c.ready)
          );
          if (running) {
            spinner.log('Gloo Operator pod is running', 'success');
            return;
          }
        } catch {
          /* continue polling */
        }
      }

      await sleep(DEFAULTS.POLL_INTERVAL_MS);
    }

    throw new Error('Gloo Operator pod did not become ready within timeout');
  }

  static async #applyServiceMeshController({
    cluster,
    cfg,
    flags,
    opNamespace,
    istioNamespace,
    imageConfig,
    scalingProfile,
    smcSpec = {},
    templateContext,
    spinner,
  }) {
    // Resolve {{ cluster.name }} etc. in user-supplied spec
    const userSpec = TemplateResolver.resolveValues(smcSpec, templateContext);

    // Base spec — auto-derived defaults, overridable via smcSpec
    const resolvedSpec = {
      cluster: cluster.name,
      network: cluster.name,
      dataplaneMode: 'Ambient',
      installNamespace: istioNamespace,
      version: cfg.istioVersion,
    };

    // Compat: operator.image.istioRepo (overridden by smcSpec.image if present)
    if (imageConfig?.istioRepo && !userSpec.image) {
      resolvedSpec.image = { repository: imageConfig.istioRepo };
    }

    // Compat: operator.scalingProfile (overridden by smcSpec.scalingProfile if present)
    if (scalingProfile && !userSpec.scalingProfile) {
      resolvedSpec.scalingProfile = scalingProfile;
    }

    // Apply resolved user spec — all fields including cluster/network overridable
    Object.assign(resolvedSpec, userSpec);

    const cr = {
      apiVersion: 'operator.gloo.solo.io/v1',
      kind: 'ServiceMeshController',
      metadata: {
        name: 'managed-istio',
        namespace: opNamespace,
        labels: {
          'app.kubernetes.io/name': 'managed-istio',
        },
      },
      spec: resolvedSpec,
    };

    const yamlContent = yaml.dump(cr, { lineWidth: -1 });
    const tempFile = `/tmp/.agentic-smc-${process.pid}.yaml`;

    const { writeFileSync, unlinkSync } = await import('fs');
    writeFileSync(tempFile, yamlContent);

    try {
      await CommandRunner.exec(`kubectl ${flags.kubectl} apply -f ${tempFile}`);
      spinner.log('ServiceMeshController CR applied', 'success');
    } finally {
      try {
        unlinkSync(tempFile);
      } catch {
        /* best effort */
      }
    }
  }

  static async #patchZtunnelEnv(envVars, istioNamespace, flags, spinner) {
    const envArgs = envVars.map(e => `${e.name}=${e.value}`).join(' ');
    const result = await CommandRunner.exec(
      `kubectl ${flags.kubectl} set env daemonset/ztunnel -n ${istioNamespace} ${envArgs}`,
      { ignoreError: true }
    );
    if (result.exitCode) {
      throw new Error(`Failed to patch ztunnel env: ${result.stderr || result.stdout}`);
    }
    spinner.log(`ztunnel env patched: ${envArgs}`, 'success');
  }

  static async #waitForControllerReady(opNamespace, flags, spinner) {
    const maxAttempts = DEFAULTS.WAIT_TIMEOUT_SEC / (DEFAULTS.POLL_INTERVAL_MS / 1000);

    for (let i = 0; i < maxAttempts; i++) {
      const result = await CommandRunner.exec(
        `kubectl ${flags.kubectl} get servicemeshcontroller managed-istio -n ${opNamespace} -o json`,
        { ignoreError: true }
      );

      const stdout = result.stdout || '';
      if (stdout) {
        try {
          const smc = JSON.parse(stdout);
          const phase = smc.status?.phase;

          if (phase === 'SUCCEEDED') {
            spinner.log('ServiceMeshController phase: SUCCEEDED', 'success');
            return;
          }

          if (phase === 'FAILED') {
            const conditions = smc.status?.conditions || [];
            const failMsg = conditions.find(c => c.status === 'False')?.message || 'unknown reason';
            throw new Error(`ServiceMeshController FAILED: ${failMsg}`);
          }

          spinner.log(`ServiceMeshController phase: ${phase || 'pending'}...`);
        } catch (e) {
          if (e.message.includes('FAILED')) throw e;
        }
      }

      await sleep(DEFAULTS.POLL_INTERVAL_MS);
    }

    throw new Error('ServiceMeshController did not reach SUCCEEDED phase within timeout');
  }
}
