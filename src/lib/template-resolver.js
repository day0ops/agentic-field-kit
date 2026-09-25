import { Logger } from './common.js';

const TEMPLATE_REGEX = /\{\{\s*([^}]+?)\s*\}\}/g;

/**
 * Resolves template variables in profile values at install time.
 *
 * Supported variables:
 *   {{ cluster.name }}                          - current cluster's name
 *   {{ cluster.context }}                       - current cluster's kube context
 *   {{ cluster.role }}                          - current cluster's role
 *   {{ env.dns.parentZone.hostedZoneId }}       - environment spec fields (requires environment)
 *   {{ env.aws.region }}                        - environment spec fields (requires environment)
 *   {{ infra.clusters.<name>.network.vpcId }}          - infra state network fields (requires infraState)
 *   {{ infra.clusters.<name>.network.privateSubnetIds}} - resolves to array (full-value token)
 */
export const TemplateResolver = {
  /**
   * Build a context object for template resolution.
   *
   * @param {object} cluster - Current cluster: { name, context, role }
   * @param {object} [environment] - Loaded environment object (spec used for env.* variables)
   * @param {object} [infraState] - Loaded infra state (status.clusters used for infra.clusters.* variables)
   * @returns {object} Context object for variable lookup
   */
  buildContext(cluster, environment = null, infraState = null) {
    const ctx = {
      cluster: {
        name: cluster.name || '',
        context: cluster.context || '',
        role: cluster.role || '',
      },
    };
    if (environment?.spec) {
      ctx.env = environment.spec;
    }
    if (infraState?.status?.clusters) {
      ctx.infra = {
        clusters: Object.fromEntries(infraState.status.clusters.map(c => [c.name, c])),
      };
    }
    return ctx;
  },

  /**
   * Resolve a single template string.
   * Returns the original string if no templates are found.
   * If the entire string is one {{...}} token, returns the raw resolved value
   * (preserving arrays/objects). Otherwise returns a string with tokens replaced.
   */
  resolveString(str, context) {
    if (typeof str !== 'string') return str;

    // Full-value token: entire string is a single {{...}} — return raw value to preserve type
    const fullMatch = str.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
    if (fullMatch) {
      const value = resolvePath(context, fullMatch[1].trim());
      if (value === undefined) {
        Logger.warn(`Unresolved template variable: ${str}`);
        return str;
      }
      return value;
    }

    return str.replace(TEMPLATE_REGEX, (match, path) => {
      const value = resolvePath(context, path.trim());
      if (value === undefined) {
        Logger.warn(`Unresolved template variable: ${match}`);
        return match;
      }
      return value;
    });
  },

  /**
   * Recursively resolve all template strings in a values object.
   */
  resolveValues(values, context) {
    if (!values) return values;
    return resolveDeep(values, context);
  },
};

function resolvePath(obj, path) {
  // Split on dots but keep array index notation together: "a.b[0].c" → ["a","b[0]","c"]
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    const indexMatch = part.match(/^([^[]+)\[(\d+)\]$/);
    if (indexMatch) {
      current = current[indexMatch[1]];
      if (current === undefined || current === null) return undefined;
      current = current[Number(indexMatch[2])];
    } else {
      current = current[part];
    }
  }
  return current;
}

function resolveDeep(value, context) {
  if (typeof value === 'string') {
    return TemplateResolver.resolveString(value, context);
  }

  if (Array.isArray(value)) {
    return value.map(item => resolveDeep(item, context));
  }

  if (value && typeof value === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = resolveDeep(v, context);
    }
    return result;
  }

  return value;
}
