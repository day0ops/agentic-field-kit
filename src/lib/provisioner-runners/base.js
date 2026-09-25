import { Logger } from '../common.js';

/**
 * BaseProvisionerRunner
 * Abstract base class for provisioner runners
 */
export class BaseProvisionerRunner {
  /**
   * Create a new provisioner runner
   * @param {string} profileName - The profile name
   * @param {object[]} clusters - Array of cluster definitions
   * @param {object} options - Runner options
   */
  constructor(profileName, clusters, options = {}) {
    this.profileName = profileName;
    this.clusters = clusters;
    this.outputDir = options.outputDir;
    this.kubeconfigDir = options.kubeconfigDir;
    this.autoApprove = options.autoApprove || false;
    this.dnsConfig = options.dnsConfig || null;

    if (new.target === BaseProvisionerRunner) {
      throw new Error(
        'BaseProvisionerRunner is an abstract class and cannot be instantiated directly'
      );
    }
  }

  /**
   * Get the provisioner type name
   * @returns {string} The provisioner type
   */
  static get type() {
    throw new Error('Subclass must implement static type getter');
  }

  /**
   * Provision the clusters
   * @returns {Promise<object[]>} Array of provisioned cluster info
   */
  async provision() {
    throw new Error('Subclass must implement provision()');
  }

  /**
   * Destroy the provisioned clusters
   * @returns {Promise<void>}
   */
  async destroy() {
    throw new Error('Subclass must implement destroy()');
  }

  /**
   * Get cluster config for a specific cluster
   * @param {string} clusterName - The cluster name
   * @returns {object|null} The cluster config or null
   */
  getClusterConfig(clusterName) {
    return this.clusters.find(c => c.name === clusterName) || null;
  }

  /**
   * Get all cluster names
   * @returns {string[]} Array of cluster names
   */
  getClusterNames() {
    return this.clusters.map(c => c.name);
  }

  /**
   * Log an info message
   * @param {string} message - The message to log
   */
  logInfo(message) {
    Logger.info(`[${this.constructor.type}] ${message}`);
  }

  /**
   * Log a debug message
   * @param {string} message - The message to log
   */
  logDebug(message) {
    Logger.debug(`[${this.constructor.type}] ${message}`);
  }

  /**
   * Log a warning message
   * @param {string} message - The message to log
   */
  logWarn(message) {
    Logger.warn(`[${this.constructor.type}] ${message}`);
  }

  /**
   * Log an error message
   * @param {string} message - The message to log
   */
  logError(message) {
    Logger.error(`[${this.constructor.type}] ${message}`);
  }
}
