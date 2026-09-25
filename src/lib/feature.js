import yaml from 'js-yaml';
import { readFile, writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { Logger, SpinnerLogger, KubernetesHelper, CommandRunner } from './common.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');
const DEFAULT_NAMESPACE = 'default';

/**
 * Base class for all features
 * Features are modular components that configure specific Istio Ambient capabilities
 */
export class Feature {
  constructor(name, config = {}) {
    this.name = name;
    this.config = config;
    this.namespace = config.namespace || DEFAULT_NAMESPACE;
    this.appName = config.appName || null;
    this.featureName = config.featureName || null;
    // Cluster contexts: array of {name, profile, context} objects
    this.clusterContexts = config.clusterContexts || null;
    // Spinner for coordinated logging
    this.spinner = null;
    // Dry run mode
    this.dryRun = !!config.dryRun;
    this._dryRunYaml = this.dryRun ? [] : undefined;
  }

  /**
   * Set the spinner for this feature
   */
  setSpinner(spinner) {
    this.spinner = spinner;
  }

  /**
   * Log a message
   */
  log(message, level = 'info') {
    if (this.dryRun) return;
    if (this.spinner && this.spinner.isSpinning) {
      this.spinner.log(message, level);
    } else {
      Logger[level](message);
    }
  }

  /**
   * Deploy the feature
   * Must be implemented by subclasses
   */
  async deploy() {
    throw new Error(`deploy() must be implemented by ${this.constructor.name}`);
  }

  /**
   * Clean up the feature
   * Must be implemented by subclasses
   */
  async cleanup() {
    throw new Error(`cleanup() must be implemented by ${this.constructor.name}`);
  }

  /**
   * Validate feature configuration
   */
  validate() {
    return true;
  }

  /**
   * Get the path to this feature's directory
   */
  getFeaturePath() {
    return this.name;
  }

  /**
   * Helper: Apply Kubernetes resource YAML
   */
  async applyYaml(yamlContent, context = null) {
    const tempFile = join(tmpdir(), `agentic-feature-${Date.now()}.yaml`);
    try {
      await writeFile(tempFile, yamlContent, 'utf8');
      const contextFlag = context ? `--context=${context}` : '';
      await CommandRunner.exec(`kubectl ${contextFlag} apply -f ${tempFile}`);
    } catch (error) {
      throw new Error(`Failed to apply YAML: ${error.message}`);
    } finally {
      try {
        await unlink(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Helper: Apply Kubernetes resource object
   */
  async applyResource(resource, context = null) {
    const yamlContent = yaml.dump(resource, { lineWidth: -1, indent: 2 });
    if (this.dryRun && this._dryRunYaml) {
      this._dryRunYaml.push(yamlContent);
      return;
    }
    await this.applyYaml(yamlContent, context);
  }

  /**
   * Helper: Delete Kubernetes resource
   */
  async deleteResource(kind, name, namespace = this.namespace, context = null) {
    try {
      const contextFlag = context ? `--context=${context}` : '';
      await CommandRunner.exec(
        `kubectl ${contextFlag} delete ${kind} ${name} -n ${namespace} --ignore-not-found=true`
      );
    } catch {
      // Silently ignore deletion errors during cleanup
    }
  }

  /**
   * Helper: Delete all resources of a kind matching label selectors.
   * Used for label-based cleanup — more resilient than name-based when
   * resource names are dynamic or prefixed per-gateway.
   */
  async deleteByLabel(kind, labels, namespace = this.namespace, context = null) {
    const selector = Object.entries(labels)
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    const contextFlag = context ? `--context=${context}` : '';
    try {
      await CommandRunner.exec(
        `kubectl ${contextFlag} delete ${kind} -n ${namespace} -l "${selector}" --ignore-not-found=true`
      );
    } catch {
      // Silently ignore deletion errors during cleanup
    }
  }

  /**
   * Helper: Wait for Gateway to be programmed
   */
  async waitForGateway(name, namespace = this.namespace, timeout = 60, context = null) {
    try {
      this.log(`Waiting for Gateway '${name}' to be programmed...`, 'info');
      const contextFlag = context ? `--context=${context}` : '';
      await CommandRunner.exec(
        `kubectl ${contextFlag} wait --for=condition=programmed gateway ${name} -n ${namespace} --timeout=${timeout}s`
      );
      this.log(`Gateway '${name}' is programmed`, 'success');
    } catch (error) {
      this.log(`Warning: Gateway '${name}' may not be fully programmed: ${error.message}`, 'warn');
    }
  }

  /**
   * Helper: Load application YAML
   */
  async loadApplicationYaml(appName) {
    const appPath = join(PROJECT_ROOT, 'extras', 'applications', appName, `${appName}.yaml`);
    if (!existsSync(appPath)) {
      throw new Error(`Application YAML not found: ${appPath}`);
    }
    const content = await readFile(appPath, 'utf8');
    return yaml.loadAll(content);
  }

  /**
   * Helper: Extract service information from application YAML
   */
  async extractServiceInfo(appName) {
    const resources = await this.loadApplicationYaml(appName);

    const service = resources.find(r => r.kind === 'Service');
    if (!service) {
      throw new Error(`No Service found in application ${appName}`);
    }

    const serviceName = service.metadata.name;
    const namespace = service.metadata.namespace || 'default';

    const ports = service.spec?.ports || [];
    const httpPort = ports.find(p => p.name === 'http' || p.port) || ports[0];
    const port = httpPort?.port || httpPort?.targetPort || 80;

    return {
      name: serviceName,
      namespace,
      port,
    };
  }

  /**
   * Helper: Ensure namespace exists and is labeled for Ambient mode
   */
  async ensureNamespace(namespace, context = null) {
    const contextFlag = context ? `--context=${context}` : '';

    try {
      await CommandRunner.exec(
        `kubectl ${contextFlag} create namespace ${namespace} --dry-run=client -o yaml | kubectl ${contextFlag} apply -f -`
      );
    } catch {
      // Namespace might already exist
    }

    await KubernetesHelper.labelNamespaceForAmbient(namespace, context, { quiet: true });
    this.log(`Namespace '${namespace}' labeled for Ambient mode`);
  }

  /**
   * Helper: Load and apply YAML file from feature config directory
   */
  async applyYamlFile(filename, overrides = {}, context = null) {
    const featurePath = this.getFeaturePath();
    const configPath = join(PROJECT_ROOT, 'features', featurePath, 'config', filename);

    try {
      const content = await readFile(configPath, 'utf8');
      let resource = yaml.load(content);

      if (resource.metadata && resource.metadata.namespace !== this.namespace) {
        resource.metadata.namespace = this.namespace;
      }

      if (Object.keys(overrides).length > 0) {
        resource = this.deepMerge(resource, overrides);
      }

      await this.applyResource(resource, context);
    } catch (error) {
      throw new Error(`Failed to apply YAML file ${filename}: ${error.message}`);
    }
  }

  /**
   * Helper: Deep merge two objects
   */
  deepMerge(target, source) {
    const output = { ...target };

    for (const key in source) {
      if (source[key] === undefined) {
        delete output[key];
      } else if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        output[key] = this.deepMerge(target[key] || {}, source[key]);
      } else {
        output[key] = source[key];
      }
    }

    return output;
  }
}

/**
 * Base class for addon features (cert-manager, keycloak, solo-ui, etc.)
 * Addons are infrastructure components that should NOT be labeled for Ambient mode.
 */
export class AddonFeature extends Feature {
  async ensureNamespace(namespace, context = null) {
    const contextFlag = context ? `--context=${context}` : '';
    try {
      await CommandRunner.exec(
        `kubectl ${contextFlag} create namespace ${namespace} --dry-run=client -o yaml | kubectl ${contextFlag} apply -f -`
      );
    } catch {
      // Namespace might already exist
    }
    // Intentionally skip labelNamespaceForAmbient — addon namespaces are infrastructure
  }
}

/**
 * Feature Manager - Orchestrates feature deployment
 */
export class FeatureManager {
  static features = new Map();
  static defaultNamespace = DEFAULT_NAMESPACE;

  /**
   * Register a feature
   */
  static register(name, featureClass) {
    this.features.set(name, featureClass);
  }

  /**
   * Set the default namespace for all features
   */
  static setDefaultNamespace(namespace) {
    this.defaultNamespace = namespace;
  }

  /**
   * Get the default namespace
   */
  static getDefaultNamespace() {
    return this.defaultNamespace;
  }

  /**
   * Check if a feature is registered
   */
  static has(name) {
    return this.features.has(name);
  }

  /**
   * Get a registered feature class
   */
  static get(name) {
    return this.features.get(name);
  }

  /**
   * Deploy a feature
   */
  static async deploy(name, config = {}, options = {}) {
    const FeatureClass = this.get(name);

    if (!FeatureClass) {
      throw new Error(`Feature '${name}' is not registered`);
    }

    const isAddon = FeatureClass.prototype instanceof AddonFeature;
    const finalConfig = {
      ...(isAddon ? {} : { namespace: this.defaultNamespace }),
      ...config,
    };

    if (options.dryRun) {
      finalConfig.dryRun = true;
    }

    const feature = new FeatureClass(name, finalConfig);
    const spinner = new SpinnerLogger();

    try {
      if (!options.dryRun && !feature.validate()) {
        throw new Error(`Invalid configuration for feature '${name}'`);
      }

      if (options.dryRun) {
        await feature.deploy();
        return feature._dryRunYaml || [];
      }

      const namespaceMsg =
        feature.namespace !== this.defaultNamespace ? ` (namespace: ${feature.namespace})` : '';
      spinner.start(`Deploying: ${name}${namespaceMsg}...`);

      feature.setSpinner(spinner);

      await feature.deploy();

      spinner.succeed(`Feature '${name}' deployed successfully`);
    } catch (error) {
      spinner.fail(`Failed to deploy feature '${name}'`);
      throw error;
    }
  }

  /**
   * Clean up a feature
   */
  static async cleanup(name, config = {}) {
    const FeatureClass = this.get(name);

    if (!FeatureClass) {
      Logger.warn(`Feature '${name}' is not registered, skipping cleanup`);
      return;
    }

    const isAddon = FeatureClass.prototype instanceof AddonFeature;
    const finalConfig = {
      ...(isAddon ? {} : { namespace: this.defaultNamespace }),
      ...config,
    };

    const feature = new FeatureClass(name, finalConfig);
    const spinner = new SpinnerLogger();

    try {
      const namespaceMsg =
        feature.namespace !== this.defaultNamespace ? ` (namespace: ${feature.namespace})` : '';
      spinner.start(`Cleaning up feature: ${name}${namespaceMsg}...`);

      feature.setSpinner(spinner);
      await feature.cleanup();

      spinner.succeed(`Feature '${name}' cleaned up successfully`);
    } catch (error) {
      spinner.fail(`Failed to clean up feature '${name}'`);
      throw error;
    }
  }

  /**
   * List all registered features
   */
  static list() {
    return Array.from(this.features.keys());
  }
}
