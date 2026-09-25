const VALID_PROVIDERS = ['eks-ipv6', 'eks', 'gke', 'aks', 'multicluster'];
const VALID_CLOUDS = ['eks', 'eks-ipv6', 'gke', 'aks'];
const VALID_ROLES = ['management', 'workload', 'gateway'];
const VALID_DNS_PROVIDERS = ['route53', 'azure-dns', 'cloud-dns'];

export const InfraSchema = {
  validate(infraProfile) {
    const errors = [];

    if (!infraProfile.apiVersion) {
      errors.push('Missing required field: apiVersion');
    } else if (infraProfile.apiVersion !== 'agentic.demo/v1') {
      errors.push(`Invalid apiVersion: ${infraProfile.apiVersion}. Expected: agentic.demo/v1`);
    }

    if (!infraProfile.kind) {
      errors.push('Missing required field: kind');
    } else if (infraProfile.kind !== 'InfraProfile') {
      errors.push(`Invalid kind: ${infraProfile.kind}. Expected: InfraProfile`);
    }

    if (!infraProfile.metadata) {
      errors.push('Missing required field: metadata');
    } else if (!infraProfile.metadata.name) {
      errors.push('Missing required field: metadata.name');
    }

    if (!infraProfile.spec) {
      errors.push('Missing required field: spec');
    } else {
      if (!infraProfile.spec.provider) {
        errors.push('Missing required field: spec.provider');
      } else if (!VALID_PROVIDERS.includes(infraProfile.spec.provider)) {
        errors.push(
          `Invalid provider: ${infraProfile.spec.provider}. Valid values: ${VALID_PROVIDERS.join(', ')}`
        );
      }

      const isMulticluster = infraProfile.spec.provider === 'multicluster';

      if (!infraProfile.spec.clusters || !Array.isArray(infraProfile.spec.clusters)) {
        errors.push('Missing or invalid field: spec.clusters (must be an array)');
      } else {
        const names = new Set();
        infraProfile.spec.clusters.forEach((cluster, index) => {
          const prefix = `spec.clusters[${index}]`;
          if (!cluster.name) {
            errors.push(`${prefix}: Missing required field: name`);
          } else {
            if (names.has(cluster.name)) {
              errors.push(`${prefix}: Duplicate cluster name: ${cluster.name}`);
            }
            names.add(cluster.name);
          }

          if (cluster.role && !VALID_ROLES.includes(cluster.role)) {
            errors.push(
              `${prefix}: Invalid role: ${cluster.role}. Valid values: ${VALID_ROLES.join(', ')}`
            );
          }

          if (isMulticluster) {
            if (!cluster.cloud) {
              errors.push(`${prefix}: Missing required field 'cloud' for multicluster provider`);
            } else if (!VALID_CLOUDS.includes(cluster.cloud)) {
              errors.push(
                `${prefix}: Invalid cloud: ${cluster.cloud}. Valid values: ${VALID_CLOUDS.join(', ')}`
              );
            }
          }
        });
      }
    }

    return { valid: errors.length === 0, errors };
  },

  getAllClusters(infraProfile) {
    return infraProfile.spec?.clusters || [];
  },

  getProvider(infraProfile) {
    return infraProfile.spec?.provider || null;
  },

  getRegion(infraProfile, environment = null) {
    return infraProfile.spec?.region || environment?.spec?.aws?.region || null;
  },

  getSettings(infraProfile) {
    return infraProfile.spec?.settings || {};
  },

  getClusterRegion(infraProfile, cluster, environment = null) {
    return cluster.region || infraProfile.spec?.region || environment?.spec?.aws?.region || null;
  },

  getClustersByRole(infraProfile, role) {
    return (infraProfile.spec?.clusters || []).filter(c => c.role === role);
  },

  getClustersByCloud(infraProfile, cloud) {
    return (infraProfile.spec?.clusters || []).filter(c => c.cloud === cloud);
  },

  getManagementCluster(infraProfile) {
    const mgmt = this.getClustersByRole(infraProfile, 'management');
    return mgmt.length > 0 ? mgmt[0] : null;
  },

  getWorkloadClusters(infraProfile) {
    return this.getClustersByRole(infraProfile, 'workload');
  },

  getValidProviders() {
    return [...VALID_PROVIDERS];
  },

  getValidClouds() {
    return [...VALID_CLOUDS];
  },

  getValidRoles() {
    return [...VALID_ROLES];
  },

  getValidDnsProviders() {
    return [...VALID_DNS_PROVIDERS];
  },

  getName(infraProfile) {
    return infraProfile.spec?.name || null;
  },

  getEnvironment(infraProfile) {
    return infraProfile.spec?.environment || null;
  },

  getDns(infraProfile) {
    return infraProfile.spec?.dns || null;
  },
};
