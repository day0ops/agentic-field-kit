import { ProfileSchema } from './profile-schema.js';

/**
 * Deep merge two objects. Arrays are replaced, not concatenated.
 * Source values overwrite target values at each key.
 */
function deepMerge(target, source) {
  if (!source) return target;
  if (!target) return source;

  const result = { ...target };

  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];

    if (Array.isArray(srcVal)) {
      result[key] = [...srcVal];
    } else if (srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal)) {
      result[key] = deepMerge(tgtVal && typeof tgtVal === 'object' ? tgtVal : {}, srcVal);
    } else {
      result[key] = srcVal;
    }
  }

  return result;
}

/**
 * Merge addon lists. Later entries override earlier ones by name.
 */
function mergeAddons(base, override) {
  if (!override || override.length === 0) return base || [];
  if (!base || base.length === 0) return override;

  const byName = new Map();

  for (const addon of base) {
    const name = typeof addon === 'string' ? addon : addon.name;
    byName.set(name, addon);
  }

  for (const addon of override) {
    const name = typeof addon === 'string' ? addon : addon.name;
    byName.set(name, addon);
  }

  return [...byName.values()];
}

export const ConfigResolver = {
  /**
   * Resolve the effective config for a single cluster.
   *
   * @param {object} profile - The loaded Profile YAML
   * @param {object} cluster - Cluster info: { name, role, context }
   * @returns {{ components: string[], componentValues: object, addons: object[] }}
   */
  resolveForCluster(profile, cluster) {
    const baseComponentsRaw = ProfileSchema.getBaseComponents(profile);
    const { names: baseNames, componentValues: baseComponentValues } =
      ProfileSchema.normalizeComponents(baseComponentsRaw);
    const baseAddons = ProfileSchema.getBaseAddons(profile);

    let components = [...baseNames];
    let componentValues = { ...baseComponentValues };
    let addons = [...baseAddons];

    if (cluster.role) {
      const roleConfig = ProfileSchema.getRoleConfig(profile, cluster.role);
      if (roleConfig) {
        if (roleConfig.components) {
          const normalized = ProfileSchema.normalizeComponents(roleConfig.components);
          components = [...normalized.names];
          for (const [name, vals] of Object.entries(normalized.componentValues)) {
            componentValues[name] = deepMerge(componentValues[name] || {}, vals);
          }
        }
        if (roleConfig.componentValues) {
          for (const [name, vals] of Object.entries(roleConfig.componentValues)) {
            componentValues[name] = deepMerge(componentValues[name] || {}, vals);
          }
        }
        if (roleConfig.addons) {
          addons = mergeAddons(addons, roleConfig.addons);
        }
      }
    }

    const clusterAddons = ProfileSchema.getClusterAddons(profile, cluster.name);
    if (clusterAddons.length > 0) {
      addons = mergeAddons(addons, clusterAddons);
    }

    const clusterOverride = ProfileSchema.getClusterOverride(profile, cluster.name);
    if (clusterOverride) {
      if (clusterOverride.components) {
        const normalized = ProfileSchema.normalizeComponents(clusterOverride.components);
        components = [...normalized.names];
        for (const [name, vals] of Object.entries(normalized.componentValues)) {
          componentValues[name] = deepMerge(componentValues[name] || {}, vals);
        }
      }
      if (clusterOverride.additionalComponents) {
        const normalized = ProfileSchema.normalizeComponents(clusterOverride.additionalComponents);
        for (const name of normalized.names) {
          if (!components.includes(name)) components.push(name);
        }
        for (const [name, vals] of Object.entries(normalized.componentValues)) {
          componentValues[name] = deepMerge(componentValues[name] || {}, vals);
        }
      }
      if (clusterOverride.componentValues) {
        for (const [name, vals] of Object.entries(clusterOverride.componentValues)) {
          componentValues[name] = deepMerge(componentValues[name] || {}, vals);
        }
      }
      if (clusterOverride.addons) {
        addons = mergeAddons(addons, clusterOverride.addons);
      }
    }

    return { components, componentValues, addons };
  },

  /**
   * Resolve configs for all clusters in an infra set.
   *
   * @param {object} profile - The loaded Profile YAML
   * @param {object[]} clusters - Array of { name, role, context }
   * @returns {Map<string, { components, componentValues, addons }>}
   */
  resolveForAllClusters(profile, clusters) {
    const configs = new Map();
    for (const cluster of clusters) {
      configs.set(cluster.name, this.resolveForCluster(profile, cluster));
    }
    return configs;
  },

  deepMerge,
  mergeAddons,
};
