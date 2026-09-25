/**
 * Provisioner Runners Registry
 * Maps provisioner types to their runner implementations.
 * All types are backed by the generic TerraformCloudRunner which targets
 * the appropriate terraform-cloud-provisioner environment.
 */

import { TerraformCloudRunner } from './terraform-cloud.js';

/**
 * Registry of available provisioner runners
 * Maps provisioner type string to runner class
 */
const RUNNER_REGISTRY = new Map([
  ['eks-ipv6', TerraformCloudRunner],
  ['eks', TerraformCloudRunner],
  ['gke', TerraformCloudRunner],
  ['aks', TerraformCloudRunner],
  ['multicluster', TerraformCloudRunner],
]);

/**
 * Get a provisioner runner class by type
 * @param {string} type - The provisioner type
 * @returns {typeof BaseProvisionerRunner} The runner class
 * @throws {Error} If the provisioner type is not found
 */
export function getProvisionerRunner(type) {
  const RunnerClass = RUNNER_REGISTRY.get(type);

  if (!RunnerClass) {
    const available = Array.from(RUNNER_REGISTRY.keys()).join(', ');
    throw new Error(`Unknown provisioner type: '${type}'. Available types: ${available}`);
  }

  return RunnerClass;
}

/**
 * Register a new provisioner runner
 * @param {string} type - The provisioner type
 * @param {typeof BaseProvisionerRunner} runnerClass - The runner class
 */
export function registerProvisionerRunner(type, runnerClass) {
  RUNNER_REGISTRY.set(type, runnerClass);
}

/**
 * Get all available provisioner types
 * @returns {string[]} Array of provisioner type names
 */
export function getAvailableProvisionerTypes() {
  return Array.from(RUNNER_REGISTRY.keys());
}

/**
 * Check if a provisioner type is supported
 * @param {string} type - The provisioner type
 * @returns {boolean} True if the type is supported
 */
export function isProvisionerTypeSupported(type) {
  return RUNNER_REGISTRY.has(type);
}

export { BaseProvisionerRunner } from './base.js';
export { TerraformCloudRunner } from './terraform-cloud.js';
