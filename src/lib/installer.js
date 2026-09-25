import { join } from 'path';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import yaml from 'js-yaml';
import chalk from 'chalk';
import { CommandRunner, Logger, SpinnerLogger, KubernetesHelper, BoxedOutput } from './common.js';
import { ProfileManager } from './profiles.js';
import { ProfileSchema } from './profile-schema.js';
import { ConfigResolver } from './config-resolver.js';
import { TemplateResolver } from './template-resolver.js';
import { OperatorInstaller } from './operator-installer.js';
import { FeatureManager } from './feature.js';
import {
  CertificateManager,
  SpireRootManager,
  EastWestGateway,
  ClusterLinker,
  PeeringInstaller,
} from './multicluster.js';
import { EnvironmentManager } from './environment.js';
import { InfraStateManager } from './infra-state.js';

const DEFAULTS = {
  NAMESPACE: 'istio-system',
  WAIT_TIMEOUT: '10m',
  VALIDATE_MAX_ATTEMPTS: 30,
  VALIDATE_INTERVAL_MS: 5000,
};

const CHART_MAP = {
  base: 'base',
  istiod: 'istiod',
  cni: 'cni',
  ztunnel: 'ztunnel',
  'peering-eastwest': 'peering',
};

const RELEASE_NAME_MAP = {
  base: 'istio-base',
  istiod: 'istiod',
  cni: 'istio-cni',
  ztunnel: 'ztunnel',
  'peering-eastwest': 'peering-eastwest',
};

const COMPONENT_NAMESPACE_MAP = {
  'peering-eastwest': 'istio-eastwest',
};

// Components that are deferred to the installAll() post-install phase
// (require cross-cluster info not available during per-cluster install)
const DEFERRED_COMPONENTS = new Set(['peering-remote']);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resolveConfig(profile, options = {}) {
  const istioVersion =
    ProfileSchema.getIstioVersion(profile) || options.istioVersion || process.env.ISTIO_VERSION;

  if (!istioVersion) {
    throw new Error(
      'istioVersion is required (set in profile spec.mesh.istioVersion or ISTIO_VERSION env)'
    );
  }

  const imageConfig = ProfileSchema.getImageConfig(profile);
  const istioImage =
    imageConfig.tag ||
    options.istioImage ||
    process.env.ISTIO_IMAGE ||
    (istioVersion.endsWith('-solo') ? istioVersion : `${istioVersion}-solo`);

  return {
    licenseKey: options.licenseKey || process.env.ENTERPRISE_ISTIO_LICENSE,
    istioVersion,
    istioImage,
    istioRepo:
      imageConfig.istioRepo ||
      options.istioRepo ||
      process.env.ISTIO_REPO ||
      'us-docker.pkg.dev/soloio-img/istio',
    helmIstioRepo:
      imageConfig.helmIstioRepo ||
      options.helmIstioRepo ||
      process.env.HELM_ISTIO_REPO ||
      'us-docker.pkg.dev/soloio-img/istio-helm',
    gatewayApiVersion:
      ProfileSchema.getGatewayApiVersion(profile) ||
      options.gatewayApiVersion ||
      process.env.GATEWAY_API_VERSION ||
      'v1.4.0',
    meshProfile: ProfileSchema.getMeshProfile(profile),
    installMethod: ProfileSchema.getInstallMethod(profile),
    namespace: options.namespace || process.env.NAMESPACE || DEFAULTS.NAMESPACE,
    waitTimeout: options.waitTimeout || process.env.WAIT_TIMEOUT || DEFAULTS.WAIT_TIMEOUT,
  };
}

function contextFlags(context) {
  if (!context) return { kubectl: '', helm: '' };
  return {
    kubectl: `--context=${context}`,
    helm: `--kube-context=${context}`,
  };
}

function writeTempValues(name, content) {
  const file = join(tmpdir(), `.agentic-${name}-values-${process.pid}.yaml`);
  writeFileSync(file, content);
  return file;
}

function cleanupTempFile(file) {
  if (file && existsSync(file)) {
    try {
      unlinkSync(file);
    } catch {
      /* best effort */
    }
  }
}

async function validateDeployment(namespace, name, kubectlCtxFlag, spinner = null) {
  const log = spinner || Logger;

  log.logInfo(`Validating deployment: ${name} in namespace: ${namespace}`);

  for (let attempt = 0; attempt < DEFAULTS.VALIDATE_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await CommandRunner.exec(
        `kubectl ${kubectlCtxFlag} get deployment -n ${namespace} ${name} -o json`,
        { ignoreError: true }
      );

      const stdout = result.stdout || '';
      if (stdout) {
        const obj = JSON.parse(stdout);
        const ready = obj.status?.readyReplicas || 0;
        const desired = obj.status?.replicas || 0;

        if (ready === desired && ready !== 0) {
          log.logSuccess(`Deployment ${name} is healthy (${ready}/${desired} replicas ready)`);
          return true;
        }
        log.logInfo(`Waiting for deployment ${name} (${ready}/${desired} replicas ready)...`);
      } else {
        log.logInfo(`Deployment ${name} not found yet...`);
      }
    } catch {
      log.logInfo(`Deployment ${name} not found yet...`);
    }

    await sleep(DEFAULTS.VALIDATE_INTERVAL_MS);
  }

  log.logError(`Deployment ${name} failed to become healthy within timeout`);
  await CommandRunner.exec(
    `kubectl ${kubectlCtxFlag} get deployment -n ${namespace} ${name} -o yaml`,
    { ignoreError: true }
  );
  return false;
}

async function validateDaemonset(namespace, name, kubectlCtxFlag, spinner = null) {
  const log = spinner || Logger;

  log.logInfo(`Validating daemonset: ${name} in namespace: ${namespace}`);

  for (let attempt = 0; attempt < DEFAULTS.VALIDATE_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await CommandRunner.exec(
        `kubectl ${kubectlCtxFlag} get daemonset -n ${namespace} ${name} -o json`,
        { ignoreError: true }
      );

      const stdout = result.stdout || '';
      if (stdout) {
        const obj = JSON.parse(stdout);
        const ready = obj.status?.numberReady || 0;
        const desired = obj.status?.desiredNumberScheduled || 0;

        if (ready === desired && ready !== 0) {
          log.logSuccess(`Daemonset ${name} is healthy (${ready}/${desired} pods ready)`);
          return true;
        }
        log.logInfo(`Waiting for daemonset ${name} (${ready}/${desired} pods ready)...`);
      } else {
        log.logInfo(`Daemonset ${name} not found yet...`);
      }
    } catch {
      log.logInfo(`Daemonset ${name} not found yet...`);
    }

    await sleep(DEFAULTS.VALIDATE_INTERVAL_MS);
  }

  log.logError(`Daemonset ${name} failed to become healthy within timeout`);
  await CommandRunner.exec(
    `kubectl ${kubectlCtxFlag} get daemonset -n ${namespace} ${name} -o yaml`,
    { ignoreError: true }
  );
  return false;
}

async function fetchNamespaceStatus(namespace, kubectlCtxFlag) {
  const [pods, deployments, daemonsets] = await Promise.all([
    CommandRunner.exec(`kubectl ${kubectlCtxFlag} get pods -n ${namespace} --no-headers`, {
      ignoreError: true,
    }),
    CommandRunner.exec(`kubectl ${kubectlCtxFlag} get deployments -n ${namespace} --no-headers`, {
      ignoreError: true,
    }),
    CommandRunner.exec(`kubectl ${kubectlCtxFlag} get daemonsets -n ${namespace} --no-headers`, {
      ignoreError: true,
    }),
  ]);
  return {
    deploymentLines: deployments.stdout?.trim().split('\n').filter(Boolean) || [],
    daemonsetLines: daemonsets.stdout?.trim().split('\n').filter(Boolean) || [],
    podLines: pods.stdout?.trim().split('\n').filter(Boolean) || [],
  };
}

function writeNamespaceSection(box, label, status, isFirst) {
  const { deploymentLines, daemonsetLines, podLines } = status;
  const hasContent = deploymentLines.length > 0 || daemonsetLines.length > 0 || podLines.length > 0;
  if (!hasContent) return;

  if (!isFirst) box.writeLine('');
  box.writeLine(chalk.bold.underline(label));

  if (deploymentLines.length > 0) {
    box.writeLine(chalk.bold('Deployments'));
    for (const line of deploymentLines) box.writeLine(`  ${line}`);
  }
  if (daemonsetLines.length > 0) {
    if (deploymentLines.length > 0) box.writeLine('');
    box.writeLine(chalk.bold('DaemonSets'));
    for (const line of daemonsetLines) box.writeLine(`  ${line}`);
  }
  if (podLines.length > 0) {
    if (deploymentLines.length > 0 || daemonsetLines.length > 0) box.writeLine('');
    box.writeLine(chalk.bold('Pods'));
    for (const line of podLines) box.writeLine(`  ${line}`);
  }
}

async function showStatus(namespace, kubectlCtxFlag, clusterName = '', extraNamespaces = []) {
  const allNamespaces = [namespace, ...extraNamespaces];
  const results = await Promise.all(
    allNamespaces.map(ns => fetchNamespaceStatus(ns, kubectlCtxFlag))
  );

  const title = clusterName ? `Istio Ambient — ${clusterName}` : 'Istio Ambient — Final Status';
  const box = new BoxedOutput(title);
  box.open();

  const multiNs = allNamespaces.length > 1;
  let first = true;
  for (let i = 0; i < allNamespaces.length; i++) {
    const label = multiNs ? allNamespaces[i] : '';
    if (multiNs) {
      writeNamespaceSection(box, label, results[i], first);
    } else {
      // single namespace: original flat layout (no namespace header)
      const { deploymentLines, daemonsetLines, podLines } = results[i];
      if (deploymentLines.length > 0) {
        box.writeLine(chalk.bold('Deployments'));
        for (const line of deploymentLines) box.writeLine(`  ${line}`);
      }
      if (daemonsetLines.length > 0) {
        if (deploymentLines.length > 0) box.writeLine('');
        box.writeLine(chalk.bold('DaemonSets'));
        for (const line of daemonsetLines) box.writeLine(`  ${line}`);
      }
      if (podLines.length > 0) {
        if (deploymentLines.length > 0 || daemonsetLines.length > 0) box.writeLine('');
        box.writeLine(chalk.bold('Pods'));
        for (const line of podLines) box.writeLine(`  ${line}`);
      }
    }
    const hasContent =
      results[i].deploymentLines.length > 0 ||
      results[i].daemonsetLines.length > 0 ||
      results[i].podLines.length > 0;
    if (hasContent) first = false;
  }

  box.close();
}

function getPostValidator(componentName, namespace, flags, spinner = null) {
  switch (componentName) {
    case 'istiod':
      return () => validateDeployment(namespace, 'istiod', flags.kubectl, spinner);
    case 'cni':
      return async () => {
        const dsCheck = await CommandRunner.exec(
          `kubectl ${flags.kubectl} get daemonset -n ${namespace} istio-cni`,
          { ignoreError: true }
        );
        if (!dsCheck.exitCode) {
          return validateDaemonset(namespace, 'istio-cni', flags.kubectl, spinner);
        }
        const depCheck = await CommandRunner.exec(
          `kubectl ${flags.kubectl} get deployment -n ${namespace} istio-cni`,
          { ignoreError: true }
        );
        if (!depCheck.exitCode) {
          return validateDeployment(namespace, 'istio-cni', flags.kubectl, spinner);
        }
        return true;
      };
    case 'ztunnel':
      return () => validateDaemonset(namespace, 'ztunnel', flags.kubectl, spinner);
    case 'peering-eastwest':
      return () => validateDeployment('istio-eastwest', 'istio-eastwest', flags.kubectl, spinner);
    default:
      return null;
  }
}

/**
 * Build component-specific base values that are always needed (hub, tag, license, etc.)
 */
function buildComponentBaseValues(componentName, cfg) {
  switch (componentName) {
    case 'base':
      return {
        defaultRevision: 'stable',
        profile: cfg.meshProfile,
      };
    case 'istiod':
      return {
        global: {
          hub: cfg.istioRepo,
          tag: cfg.istioImage,
          proxy: { clusterDomain: 'cluster.local' },
        },
        profile: cfg.meshProfile,
        license: { value: cfg.licenseKey },
      };
    case 'cni':
      return {
        ambient: { dnsCapture: true },
        excludeNamespaces: [cfg.namespace, 'kube-system'],
        global: {
          hub: cfg.istioRepo,
          tag: cfg.istioImage,
        },
        profile: cfg.meshProfile,
      };
    case 'ztunnel':
      return {
        hub: cfg.istioRepo,
        tag: cfg.istioImage,
        profile: cfg.meshProfile,
        istioNamespace: cfg.namespace,
        namespace: cfg.namespace,
        enabled: true,
        configValidation: true,
        env: { L7_ENABLED: 'true' },
        proxy: { clusterDomain: 'cluster.local' },
        terminationGracePeriodSeconds: 29,
        variant: 'distroless',
      };
    case 'peering-eastwest':
      return {
        eastwest: {
          create: true,
          deployment: {},
        },
      };
    default:
      return {};
  }
}

export class InstallerManager {
  /**
   * Install mesh on a single cluster using a resolved profile config.
   *
   * @param {object} options
   * @param {object} options.profile - Loaded profile YAML
   * @param {object} options.cluster - { name, context, role }
   * @param {object} [options.templateContext] - Template resolution context
   * @param {string} [options.licenseKey]
   */
  static async installCluster(options = {}) {
    const {
      profile,
      cluster,
      templateContext,
      allClusters,
      licenseKey = process.env.ENTERPRISE_ISTIO_LICENSE,
    } = options;

    if (!profile) throw new Error('profile is required');
    if (!cluster) throw new Error('cluster is required');
    if (!licenseKey) throw new Error('ENTERPRISE_ISTIO_LICENSE is required for installation');

    const cfg = resolveConfig(profile, { ...options, licenseKey });

    if (cfg.installMethod === 'operator') {
      await this.#installAddons({ profile, cluster, phase: 'pre', templateContext });
      await OperatorInstaller.installCluster({
        profile,
        cluster,
        templateContext,
        allClusters,
        cfg,
      });
      const flags = contextFlags(cluster.context);
      const resolved = ConfigResolver.resolveForCluster(profile, cluster);
      const extraNs = resolved.components.includes('peering-eastwest') ? ['istio-eastwest'] : [];
      await showStatus(cfg.namespace, flags.kubectl, cluster.name, extraNs);
      await this.#installAddons({ profile, cluster, phase: 'post', templateContext });
      return;
    }

    return this.#installClusterHelm({ profile, cluster, templateContext, allClusters, cfg });
  }

  static async #installAddons({ profile, cluster, phase = 'pre', templateContext = null }) {
    const resolved = ConfigResolver.resolveForCluster(profile, cluster);
    if (!resolved.addons || resolved.addons.length === 0) return;

    const phaseAddons = resolved.addons.filter(addon => {
      const addonPhase = (typeof addon === 'string' ? 'pre' : addon.phase) || 'pre';
      return addonPhase === phase;
    });
    if (phaseAddons.length === 0) return;

    // Build the full set of addon names configured for this cluster (all phases)
    // so each addon can inspect its peers without needing explicit flags in the profile.
    const clusterAddons = resolved.addons.map(a => (typeof a === 'string' ? a : a.name));

    Logger.info(`Installing addons (phase: ${phase})...`);
    for (const addon of phaseAddons) {
      const addonName = typeof addon === 'string' ? addon : addon.name;
      let addonConfig = typeof addon === 'string' ? {} : { ...addon };
      // Flatten nested 'config:' key so addon constructors can read fields at the top level
      if (addonConfig.config && typeof addonConfig.config === 'object') {
        Object.assign(addonConfig, addonConfig.config);
      }
      // Resolve {{ cluster.* }} and {{ env.* }} template variables in addon config
      if (templateContext) {
        addonConfig = TemplateResolver.resolveValues(addonConfig, templateContext);
      }
      addonConfig.kubeContext = cluster.context;
      // Inject cluster identity — addons can use these without hardcoding in profile YAML
      if (!addonConfig.clusterName) addonConfig.clusterName = cluster.name;
      if (!addonConfig.clusterRole) addonConfig.clusterRole = cluster.role || null;
      // Inject peer addon names — addons can check for co-installed addons
      addonConfig.clusterAddons = clusterAddons;
      if (!FeatureManager.has(addonName)) {
        Logger.warn(`Addon '${addonName}' is not registered, skipping`);
        continue;
      }
      await FeatureManager.deploy(addonName, addonConfig);
    }
  }

  static #validateAllAddons({ profile, clusters, environment, infraState }) {
    const errors = [];
    for (const cluster of clusters) {
      const resolved = ConfigResolver.resolveForCluster(profile, cluster);
      if (!resolved.addons || resolved.addons.length === 0) continue;
      const templateContext = TemplateResolver.buildContext(cluster, environment, infraState);
      for (const addon of resolved.addons) {
        const addonName = typeof addon === 'string' ? addon : addon.name;
        if (!FeatureManager.has(addonName)) continue;
        let addonConfig = typeof addon === 'string' ? {} : { ...addon };
        if (addonConfig.config && typeof addonConfig.config === 'object') {
          Object.assign(addonConfig, addonConfig.config);
        }
        addonConfig = TemplateResolver.resolveValues(addonConfig, templateContext);
        addonConfig.kubeContext = cluster.context;
        addonConfig.clusterName = addonConfig.clusterName || cluster.name;
        addonConfig.clusterRole = addonConfig.clusterRole || cluster.role || null;
        const FeatureClass = FeatureManager.get(addonName);
        const feature = new FeatureClass(addonName, addonConfig);
        try {
          if (feature.validate() === false) {
            errors.push(`  [${cluster.name}/${addonName}] Invalid configuration`);
          }
        } catch (err) {
          errors.push(`  [${cluster.name}/${addonName}] ${err.message}`);
        }
      }
    }
    if (errors.length > 0) {
      throw new Error(`Pre-install validation failed:\n${errors.join('\n')}`);
    }
  }

  static async #installClusterHelm({
    profile,
    cluster,
    templateContext,
    allClusters: _allClusters,
    cfg,
  }) {
    const flags = contextFlags(cluster.context);
    const contextDisplay = cluster.context || 'current context';
    const spinner = new SpinnerLogger();

    const resolved = ConfigResolver.resolveForCluster(profile, cluster);

    if (templateContext) {
      for (const [name, vals] of Object.entries(resolved.componentValues)) {
        resolved.componentValues[name] = TemplateResolver.resolveValues(vals, templateContext);
      }
    }

    spinner.start(`Installing Istio Ambient on ${cluster.name} (${contextDisplay})...`);

    try {
      spinner.logInfo(`Cluster: ${cluster.name} (role: ${cluster.role || 'default'})`);
      spinner.logInfo(`  INSTALL_METHOD: helm`);
      spinner.logInfo(`  ISTIO_VERSION:  ${cfg.istioVersion}`);
      spinner.logInfo(`  COMPONENTS:     ${resolved.components.join(', ')}`);
      spinner.logInfo(`  ISTIO_REPO:     ${cfg.istioRepo}`);
      spinner.logInfo(`  NAMESPACE:      ${cfg.namespace}`);

      await CommandRunner.exec(
        `kubectl ${flags.kubectl} create namespace ${cfg.namespace} --dry-run=client -o yaml | kubectl ${flags.kubectl} apply -f -`
      );

      spinner.setText('Installing Gateway API CRDs...');
      await this.#installGatewayApi(cfg, flags, spinner);

      spinner.succeed('Pre-requisites ready — installing pre-install addons...');
      await this.#installAddons({ profile, cluster, phase: 'pre', templateContext });

      spinner.start(`Installing Istio Ambient components on ${cluster.name}...`);

      for (const component of resolved.components) {
        if (DEFERRED_COMPONENTS.has(component)) {
          spinner.logInfo(`${component}: deferred to post-install phase`);
          continue;
        }

        if (component === 'ingress-gateway') {
          const gatewayConfig = resolved.componentValues['ingress-gateway']?.gateway;
          if (gatewayConfig) {
            spinner.setText(`Creating ingress Gateway...`);
            await InstallerManager.#applyIngressGatewayResource(gatewayConfig, flags, spinner);
          } else {
            spinner.logWarn('ingress-gateway: no gateway config, skipping');
          }
          continue;
        }

        const chartName = CHART_MAP[component];
        const releaseName = RELEASE_NAME_MAP[component];
        if (!chartName) {
          spinner.logWarn(`Unknown component: ${component}, skipping`);
          continue;
        }

        spinner.setText(`Installing ${component}...`);

        if (component === 'peering-eastwest') {
          await PeeringInstaller.deployEastWest({
            cluster,
            helmRepo: cfg.helmIstioRepo,
            version: cfg.istioImage,
            componentValues: resolved.componentValues['peering-eastwest'] || {},
            flags,
            logger: spinner,
          });
          const validator = getPostValidator(component, 'istio-eastwest', flags, spinner);
          if (validator) await validator();
          continue;
        }

        const componentBase = buildComponentBaseValues(component, cfg);
        const mergedValues = ConfigResolver.deepMerge(
          componentBase,
          resolved.componentValues[component] || {}
        );
        const valuesYaml = yaml.dump(mergedValues, {
          lineWidth: -1,
          quotingType: '"',
          forceQuotes: false,
        });
        const componentNamespace = COMPONENT_NAMESPACE_MAP[component] || cfg.namespace;

        await this.#installHelmChart(releaseName, chartName, cfg, flags, {
          values: valuesYaml,
          postValidate: getPostValidator(component, componentNamespace, flags, spinner),
          spinner,
          namespace: componentNamespace,
        });
      }

      spinner.setText('Labeling istio-system namespace with network topology...');
      await CommandRunner.exec(
        `kubectl ${flags.kubectl} label namespace ${cfg.namespace} topology.istio.io/network=${cluster.name} --overwrite`,
        { ignoreError: true }
      );

      const extraNs = resolved.components.includes('peering-eastwest') ? ['istio-eastwest'] : [];
      await showStatus(cfg.namespace, flags.kubectl, cluster.name, extraNs);

      spinner.succeed('Istio Ambient installed — installing post-install addons...');
      await this.#installAddons({ profile, cluster, phase: 'post', templateContext });

      spinner.succeed(`Agentic stack installed on ${cluster.name} (${contextDisplay})`);
      return true;
    } catch (error) {
      spinner.fail(`Failed to install on ${cluster.name}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Install mesh on multiple clusters using a profile.
   * Management clusters are installed first (for Option 3 compatibility).
   *
   * @param {object} options
   * @param {string} options.profileName - Profile name from config/profiles/
   * @param {object[]} options.clusters - Array of { name, context, role }
   * @param {string} [options.licenseKey]
   */
  static async installAll(options = {}) {
    const { profileName, clusters, licenseKey = process.env.ENTERPRISE_ISTIO_LICENSE } = options;

    if (!profileName) throw new Error('profileName is required');
    if (!clusters || clusters.length === 0) throw new Error('At least one cluster is required');
    if (!licenseKey) throw new Error('ENTERPRISE_ISTIO_LICENSE is required for installation');

    for (const cluster of clusters) {
      const flag = contextFlags(cluster.context).kubectl;
      if (!(await KubernetesHelper.isClusterAccessible(flag))) {
        throw new Error(
          `Cluster '${cluster.name}' (context: ${cluster.context}) is not accessible. Check your kubeconfig and credentials (e.g. aws sso login).`
        );
      }
    }
    Logger.info('All clusters verified accessible');

    const profile = await ProfileManager.load(profileName);

    const environmentName = ProfileSchema.getEnvironment(profile);
    let environment = null;
    if (environmentName) {
      try {
        environment = await EnvironmentManager.load(environmentName);
      } catch (_err) {
        Logger.warn(`Could not load environment '${environmentName}' for template resolution`);
      }
    }

    const infraProfileName = ProfileSchema.getInfra(profile);
    let infraState = null;
    if (infraProfileName) {
      try {
        infraState = await InfraStateManager.load(infraProfileName);
      } catch {
        /* best effort */
      }
    }

    Logger.info(`Profile: ${profileName}`);
    Logger.info(`Installing Istio Ambient on ${clusters.length} cluster(s):`);
    for (const c of clusters) {
      Logger.info(`  - ${c.name} (${c.role || 'default'}): ${c.context}`);
    }

    await InstallerManager.#validateAllAddons({ profile, clusters, environment, infraState });

    const installStartTime = Date.now();

    const mgmtClusters = clusters.filter(c => c.role === 'management');
    const otherClusters = clusters.filter(c => c.role !== 'management');
    const orderedClusters = [...mgmtClusters, ...otherClusters];

    // For multicluster: install shared root CA + per-cluster intermediate CAs
    // before istiod starts so cacerts secret is present at istiod startup.
    if (clusters.length > 1) {
      const certMode = ProfileSchema.getCertMode(profile);
      const clusterList = orderedClusters.map(c => ({ name: c.name, context: c.context }));
      console.log();
      Logger.info('Setting up shared root of trust...');
      await new CertificateManager({ mode: certMode, clusters: clusterList }).deploy();
    }

    // For SPIRE distinctRoots mode: pre-generate one independent root per cluster whose
    // spire addon config requests it, before any cluster installs, so every cluster's
    // SPIRE deploy can discover and trust every peer's root immediately (see
    // SpireRootManager and addons/spire/index.js).
    const distinctRootClusters = [];
    for (const cluster of orderedClusters) {
      const resolved = ConfigResolver.resolveForCluster(profile, cluster);
      const spireEntry = (resolved.addons || []).find(
        addon => (typeof addon === 'string' ? addon : addon.name) === 'spire'
      );
      if (!spireEntry || typeof spireEntry === 'string') continue;

      let spireConfig = { ...spireEntry };
      if (spireConfig.config && typeof spireConfig.config === 'object') {
        Object.assign(spireConfig, spireConfig.config);
      }
      const templateCtx = TemplateResolver.buildContext(cluster, environment, infraState);
      spireConfig = TemplateResolver.resolveValues(spireConfig, templateCtx);

      if (spireConfig.distinctRoots === true) {
        distinctRootClusters.push({
          name: cluster.name,
          trustDomain: spireConfig.trustDomain || `${cluster.name}.local`,
        });
      }
    }
    if (distinctRootClusters.length > 0) {
      console.log();
      Logger.info('Generating independent SPIRE roots...');
      await new SpireRootManager({ clusters: distinctRootClusters }).deploy();
    }

    for (const cluster of orderedClusters) {
      const templateCtx = TemplateResolver.buildContext(cluster, environment, infraState);

      console.log();
      Logger.info(`Installing on cluster: ${cluster.name} (${cluster.role || 'default'})`);
      await this.installCluster({
        profile,
        cluster,
        templateContext: templateCtx,
        allClusters: orderedClusters,
        licenseKey,
      });
    }

    if (clusters.length > 1) {
      console.log();
      Logger.info('Configuring multicluster connectivity...');
      const clusterList = orderedClusters.map(c => ({ name: c.name, context: c.context }));
      const cfg = resolveConfig(profile, { licenseKey });
      const peeringMethod = ProfileSchema.getPeeringMethod(profile);

      const hasEastWestComponent = orderedClusters.some(c => {
        const resolved = ConfigResolver.resolveForCluster(profile, c);
        return resolved.components.includes('peering-eastwest');
      });

      if (!hasEastWestComponent) {
        await new EastWestGateway({ clusters: clusterList, namespace: 'istio-eastwest' }).deploy();
      }

      const firstResolved = ConfigResolver.resolveForCluster(profile, orderedClusters[0]);
      const peeringRemoteValues = firstResolved.componentValues['peering-remote'] || {};
      await new ClusterLinker({
        clusters: clusterList,
        namespace: 'istio-eastwest',
        method: peeringMethod,
        helmRepo: cfg.helmIstioRepo,
        istioImage: cfg.istioImage,
        peeringRemoteValues,
      }).deploy();
      Logger.success('Multicluster connectivity configured');
    }

    const elapsed = Date.now() - installStartTime;
    const mins = Math.floor(elapsed / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    console.log();
    Logger.success(`Agentic stack installed on all clusters in ${duration}`);
  }

  /**
   * Delete orphaned Istio/Solo CRDs left behind after helm uninstall.
   * Matches any CRD whose name ends with .istio.io or .solo.io.
   */
  static async cleanupIstioCRDs(context = null, spinner = null) {
    const flags = contextFlags(context);
    const result = await CommandRunner.exec(
      `kubectl ${flags.kubectl} get crd --no-headers -o custom-columns=NAME:.metadata.name 2>/dev/null`,
      { ignoreError: true }
    );
    const crds = (result.stdout || '')
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.endsWith('.istio.io') || s.endsWith('.solo.io'));

    if (crds.length === 0) return;

    const msg = `Removing ${crds.length} orphaned Istio/Solo CRD(s)...`;
    if (spinner) spinner.log(msg);
    else Logger.info(msg);
    await CommandRunner.exec(
      `kubectl ${flags.kubectl} delete crd ${crds.join(' ')} --ignore-not-found=true`
    );
  }

  /**
   * Delete CRDs installed by profile addons (cert-manager, cilium, Gateway API,
   * external-dns, kube-prometheus-stack, Grafana alloy, agentgateway, agentregistry).
   * Called only when --addons flag is set. Skips AWS-native CRD domains.
   */
  static async cleanupAddonCRDs(context = null, spinner = null) {
    const ADDON_CRD_SUFFIXES = [
      '.cert-manager.io',
      '.acme.cert-manager.io',
      '.cilium.io',
      '.gateway.networking.k8s.io',
      '.externaldns.k8s.io',
      '.monitoring.coreos.com',
      '.monitoring.grafana.com',
      '.agentgateway.dev',
      '.ar.dev',
    ];

    const flags = contextFlags(context);
    const result = await CommandRunner.exec(
      `kubectl ${flags.kubectl} get crd --no-headers -o custom-columns=NAME:.metadata.name 2>/dev/null`,
      { ignoreError: true }
    );
    const crds = (result.stdout || '')
      .split('\n')
      .map(s => s.trim())
      .filter(s => ADDON_CRD_SUFFIXES.some(suffix => s.endsWith(suffix)));

    if (crds.length > 0) {
      const msg = `Removing ${crds.length} orphaned addon CRD(s)...`;
      if (spinner) spinner.log(msg);
      else Logger.info(msg);
      await CommandRunner.exec(
        `kubectl ${flags.kubectl} delete crd ${crds.join(' ')} --ignore-not-found=true`
      );
    }

    // Gateway API standard-install.yaml also installs cluster-scoped non-CRD resources
    // (ValidatingAdmissionPolicy/Binding named *.gateway.networking.k8s.io)
    for (const kind of ['validatingadmissionpolicy', 'validatingadmissionpolicybinding']) {
      const listResult = await CommandRunner.exec(
        `kubectl ${flags.kubectl} get ${kind} --no-headers -o custom-columns=NAME:.metadata.name 2>/dev/null`,
        { ignoreError: true }
      );
      const gwResources = (listResult.stdout || '')
        .split('\n')
        .map(s => s.trim())
        .filter(s => s.endsWith('.gateway.networking.k8s.io'));
      if (gwResources.length > 0) {
        await CommandRunner.exec(
          `kubectl ${flags.kubectl} delete ${kind} ${gwResources.join(' ')} --ignore-not-found=true`,
          { ignoreError: true }
        );
      }
    }
  }

  /**
   * Uninstall mesh from a single cluster.
   * Detects install method from the profile when provided; defaults to helm.
   */
  static async uninstallCluster({ cluster, profile, uninstallAddons = false } = {}) {
    const context = cluster?.context || null;
    const namespace = process.env.NAMESPACE || DEFAULTS.NAMESPACE;
    const contextDisplay = context || 'current context';
    const spinner = new SpinnerLogger();

    const installMethod = profile ? ProfileSchema.getInstallMethod(profile) : 'helm';

    spinner.start(`Uninstalling Istio Ambient from ${cluster?.name || contextDisplay}...`);

    try {
      if (installMethod === 'operator') {
        await OperatorInstaller.uninstall(context);
      }

      const flags = contextFlags(context);
      for (const release of ['ztunnel', 'istio-cni', 'istiod', 'istio-base']) {
        try {
          await CommandRunner.exec(`helm ${flags.helm} uninstall ${release} -n ${namespace}`);
        } catch (err) {
          if (!/not found|no deployed releases/i.test(err.message)) throw err;
        }
      }

      // Delete ingress-gateway Gateway resource if configured
      if (profile && cluster) {
        try {
          const resolved = ConfigResolver.resolveForCluster(profile, cluster);
          const igGatewayConfig = resolved.componentValues?.['ingress-gateway']?.gateway;
          if (igGatewayConfig) {
            const gwName = igGatewayConfig.name || 'istio-ingressgateway';
            const gwNs = igGatewayConfig.namespace || 'default';
            await CommandRunner.exec(
              `kubectl ${flags.kubectl} delete gateway ${gwName} -n ${gwNs} --ignore-not-found=true`,
              { ignoreError: true }
            );
            await CommandRunner.exec(
              `kubectl ${flags.kubectl} delete namespace ${gwNs} --ignore-not-found=true`,
              { ignoreError: true }
            );
          }
        } catch {
          /* best effort */
        }
      }

      await InstallerManager.cleanupIstioCRDs(context, spinner);

      if (uninstallAddons) {
        await CommandRunner.exec(
          `kubectl ${flags.kubectl} delete namespace istio-system --ignore-not-found=true`,
          { ignoreError: true }
        );
      }

      if (uninstallAddons && profile && cluster) {
        const resolved = ConfigResolver.resolveForCluster(profile, cluster);
        if (resolved.addons && resolved.addons.length > 0) {
          spinner.succeed('Istio components removed — cleaning up addons...');

          // Build template context — mirrors install path so {{env.*}} and {{infra.*}} vars resolve during cleanup
          let cleanupTemplateContext = null;
          try {
            const envName = ProfileSchema.getEnvironment(profile);
            const infraName = ProfileSchema.getInfra(profile);
            const [cleanupEnv, cleanupInfraState] = await Promise.all([
              envName ? EnvironmentManager.load(envName).catch(() => null) : Promise.resolve(null),
              infraName
                ? InfraStateManager.load(infraName).catch(() => null)
                : Promise.resolve(null),
            ]);
            if (cleanupEnv || cleanupInfraState) {
              cleanupTemplateContext = TemplateResolver.buildContext(
                cluster,
                cleanupEnv,
                cleanupInfraState
              );
            }
          } catch {
            /* best effort — proceed without template resolution if env unavailable */
          }

          // Reverse install order; always remove cilium last (CNI must stay up longest)
          const reversedAddons = [...resolved.addons].reverse();
          const ciliumIdx = reversedAddons.findIndex(
            a => (typeof a === 'string' ? a : a.name) === 'cilium'
          );
          if (ciliumIdx > -1) reversedAddons.push(reversedAddons.splice(ciliumIdx, 1)[0]);
          for (const addon of reversedAddons) {
            const addonName = typeof addon === 'string' ? addon : addon.name;
            let addonConfig = typeof addon === 'string' ? {} : { ...addon };
            // Flatten nested 'config:' key — mirrors install path in #installAddons
            if (addonConfig.config && typeof addonConfig.config === 'object') {
              Object.assign(addonConfig, addonConfig.config);
            }
            // Resolve {{ env.* }} and {{ cluster.* }} template variables — mirrors install path
            if (cleanupTemplateContext) {
              addonConfig = TemplateResolver.resolveValues(addonConfig, cleanupTemplateContext);
            }
            addonConfig.kubeContext = cluster?.context || null;
            if (!addonConfig.clusterName) addonConfig.clusterName = cluster?.name || null;
            if (!addonConfig.clusterRole) addonConfig.clusterRole = cluster?.role || null;
            if (!FeatureManager.has(addonName)) {
              continue;
            }
            await FeatureManager.cleanup(addonName, addonConfig);
          }
        }
        // CRD cleanup runs after addon cleanup so addons can still use their CRD types
        await InstallerManager.cleanupAddonCRDs(context, spinner);
      }

      const uninstalledWhat = uninstallAddons ? 'Agentic stack' : 'Istio Ambient';
      spinner.succeed(`${uninstalledWhat} uninstalled from ${cluster?.name || contextDisplay}`);
      return true;
    } catch (error) {
      spinner.fail(`Failed to uninstall from ${cluster?.name || contextDisplay}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Uninstall mesh from all clusters in a profile.
   * Mirrors installAll — resolves clusters, uninstalls in reverse order
   * (workers first, then management).
   */
  static async uninstallAll(options = {}) {
    const { profileName, clusters, uninstallAddons = false } = options;

    if (!clusters || clusters.length === 0) throw new Error('At least one cluster is required');

    for (const cluster of clusters) {
      const flag = contextFlags(cluster.context).kubectl;
      if (!(await KubernetesHelper.isClusterAccessible(flag))) {
        throw new Error(
          `Cluster '${cluster.name}' (context: ${cluster.context}) is not accessible. Check your kubeconfig and credentials (e.g. aws sso login).`
        );
      }
    }
    Logger.info('All clusters verified accessible');

    const profile = profileName ? await ProfileManager.load(profileName) : null;
    const uninstallStartTime = Date.now();

    Logger.info(`Uninstalling Istio Ambient from ${clusters.length} cluster(s):`);
    for (const c of clusters) {
      Logger.info(`  - ${c.name} (${c.role || 'default'}): ${c.context}`);
    }

    const mgmtClusters = clusters.filter(c => c.role === 'management');
    const otherClusters = clusters.filter(c => c.role !== 'management');
    const orderedClusters = [...otherClusters, ...mgmtClusters];

    if (clusters.length > 1) {
      console.log();
      Logger.info('Cleaning up multicluster connectivity...');
      const clusterList = orderedClusters.map(c => ({ name: c.name, context: c.context }));
      const peeringMethod = profile ? ProfileSchema.getPeeringMethod(profile) : 'helm';

      try {
        await new ClusterLinker({
          clusters: clusterList,
          namespace: 'istio-eastwest',
          method: peeringMethod,
        }).cleanup();
      } catch {
        Logger.warn('Could not clean up cluster links');
      }

      try {
        await new EastWestGateway({ clusters: clusterList, namespace: 'istio-eastwest' }).cleanup();
      } catch {
        Logger.warn('Could not clean up east-west gateways');
      }
    }

    for (const cluster of orderedClusters) {
      console.log();
      Logger.info(`Uninstalling from cluster: ${cluster.name} (${cluster.role || 'default'})`);
      await this.uninstallCluster({ cluster, profile, uninstallAddons });
    }

    const elapsed = Date.now() - uninstallStartTime;
    const mins = Math.floor(elapsed / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    console.log();
    const uninstalledWhat = uninstallAddons ? 'Agentic stack' : 'Istio Ambient';
    Logger.success(`${uninstalledWhat} uninstalled from all clusters in ${duration}`);
  }

  /**
   * @deprecated Use uninstallCluster instead
   */
  static async uninstall(context = null) {
    return this.uninstallCluster({ cluster: context ? { context, name: context } : null });
  }

  static async verify(context = null) {
    const namespace = process.env.NAMESPACE || DEFAULTS.NAMESPACE;
    const flags = contextFlags(context);
    const checks = [
      {
        name: 'Gateway API CRDs',
        cmd: `kubectl ${flags.kubectl} get crd gateways.gateway.networking.k8s.io`,
      },
      {
        name: 'istiod deployment',
        cmd: `kubectl ${flags.kubectl} get deployment -n ${namespace} istiod`,
      },
      {
        name: 'ztunnel daemonset',
        cmd: `kubectl ${flags.kubectl} get daemonset -n ${namespace} ztunnel`,
      },
      {
        name: 'istio-cni',
        cmd: `kubectl ${flags.kubectl} get daemonset -n ${namespace} istio-cni`,
      },
    ];

    Logger.info('Verifying Istio Ambient installation...');
    let allPassed = true;

    for (const check of checks) {
      try {
        await CommandRunner.exec(check.cmd, { ignoreError: false });
        Logger.success(`  ${check.name} found`);
      } catch {
        Logger.warn(`  ${check.name} not found`);
        allPassed = false;
      }
    }

    return allPassed;
  }

  static async #installGatewayApi(cfg, flags, spinner = null) {
    const log = spinner || Logger;

    const crdCheck = await CommandRunner.exec(
      `kubectl ${flags.kubectl} get crd gateways.gateway.networking.k8s.io`,
      { ignoreError: true }
    );

    if (!crdCheck.exitCode) {
      log.logInfo('Gateway API CRDs already exist, skipping');
      return;
    }

    await CommandRunner.exec(
      `kubectl ${flags.kubectl} apply --server-side --force-conflicts -f https://github.com/kubernetes-sigs/gateway-api/releases/download/${cfg.gatewayApiVersion}/standard-install.yaml`
    );

    log.logSuccess('Gateway API CRDs installed');
  }

  static async #applyIngressGatewayResource(gatewayConfig, flags, spinner) {
    const log = spinner || Logger;
    const name = gatewayConfig.name || 'istio-ingressgateway';
    const namespace = gatewayConfig.namespace || 'default';
    const hostname = gatewayConfig.hostname;
    const port = gatewayConfig.port || 80;
    const protocol = gatewayConfig.protocol || 'HTTP';

    let listeners;
    if (gatewayConfig.listeners) {
      listeners = gatewayConfig.listeners;
    } else {
      const allowedRoutes = gatewayConfig.allowedRoutes || { namespaces: { from: 'All' } };
      const httpListener = { name: 'http', port, protocol, allowedRoutes };
      if (hostname) httpListener.hostname = hostname;
      listeners = [httpListener];
    }

    const gateway = {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'Gateway',
      metadata: { name, namespace },
      spec: { gatewayClassName: 'istio', listeners },
    };

    log.logInfo(`Creating Gateway "${name}" (namespace: ${namespace})`);

    await CommandRunner.exec(
      `kubectl ${flags.kubectl} create namespace ${namespace} --dry-run=client -o yaml | kubectl ${flags.kubectl} apply -f -`,
      { ignoreError: true }
    );

    const valuesFile = writeTempValues(`ingressgw-${name}`, yaml.dump(gateway, { lineWidth: -1 }));
    try {
      await CommandRunner.exec(`kubectl ${flags.kubectl} apply -f ${valuesFile}`);
      log.logSuccess(`Gateway "${name}" created`);
    } finally {
      cleanupTempFile(valuesFile);
    }
  }

  static async #installHelmChart(
    releaseName,
    chartName,
    cfg,
    flags,
    { values, postValidate, spinner, namespace }
  ) {
    const targetNamespace = namespace || cfg.namespace;
    const valuesFile = writeTempValues(releaseName, values);

    try {
      await CommandRunner.exec(
        `helm ${flags.helm} upgrade --install ${releaseName} oci://${cfg.helmIstioRepo}/${chartName} ` +
          `--namespace ${targetNamespace} ` +
          `--create-namespace ` +
          `--version ${cfg.istioImage} ` +
          `--wait ` +
          `--timeout ${cfg.waitTimeout} ` +
          `-f ${valuesFile}`
      );

      const context = flags.helm ? flags.helm.replace('--kube-context=', '') : null;
      await KubernetesHelper.assertHelmDeployed(releaseName, targetNamespace, context);
      const log = spinner || Logger;
      log.logSuccess(`${releaseName} installed successfully`);
      if (postValidate) await postValidate();
    } finally {
      cleanupTempFile(valuesFile);
    }
  }
}
