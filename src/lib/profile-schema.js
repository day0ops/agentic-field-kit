const DEFAULT_COMPONENTS = [
  'base',
  'istiod',
  'cni',
  'ztunnel',
  'peering-eastwest',
  'peering-remote',
];
const VALID_COMPONENTS = [...DEFAULT_COMPONENTS, 'ingress-gateway'];
const VALID_INSTALL_METHODS = ['helm', 'operator'];
const VALID_CERT_MODES = ['self-signed', 'cert-manager'];
const VALID_SCALING_PROFILES = ['Default', 'Demo', 'Large'];
const VALID_PEERING_METHODS = ['helm', 'declarative'];

function validateMesh(mesh, errors) {
  if (!mesh) {
    errors.push('Missing required field: spec.mesh');
    return;
  }

  if (!mesh.istioVersion) {
    errors.push('Missing required field: spec.mesh.istioVersion');
  }

  const isOperator = mesh.installMethod === 'operator';
  if (!isOperator && !mesh.profile) {
    errors.push(
      'Missing required field: spec.mesh.profile (required when installMethod is not operator)'
    );
  }

  if (mesh.components) {
    validateComponents(mesh.components, 'spec.mesh.components', errors);
  }

  if (mesh.peering !== undefined) {
    if (!VALID_PEERING_METHODS.includes(mesh.peering)) {
      errors.push(
        `Invalid spec.mesh.peering: ${mesh.peering}. Valid values: ${VALID_PEERING_METHODS.join(', ')}`
      );
    }
    if (mesh.peering === 'helm') {
      const hasRemote = (mesh.components || []).some(
        c => (typeof c === 'string' ? c : c?.name) === 'peering-remote'
      );
      if (!hasRemote) {
        errors.push('spec.mesh.peering: helm requires peering-remote in components');
      }
    }
  }

  if (mesh.installMethod && !VALID_INSTALL_METHODS.includes(mesh.installMethod)) {
    errors.push(
      `Invalid installMethod: ${mesh.installMethod}. Valid values: ${VALID_INSTALL_METHODS.join(', ')}`
    );
  }

  if (mesh.certificates) {
    validateCertificates(mesh.certificates, errors);
  }

  if (mesh.operator) {
    validateOperator(mesh.operator, errors);
  }

  if (mesh.serviceMeshController !== undefined) {
    if (
      typeof mesh.serviceMeshController !== 'object' ||
      Array.isArray(mesh.serviceMeshController)
    ) {
      errors.push('spec.mesh.serviceMeshController must be an object');
    }
  }

  if (mesh.roles) {
    if (typeof mesh.roles !== 'object' || Array.isArray(mesh.roles)) {
      errors.push('spec.mesh.roles must be an object keyed by role name');
    } else {
      for (const [roleName, roleConfig] of Object.entries(mesh.roles)) {
        const prefix = `spec.mesh.roles.${roleName}`;
        if (roleConfig.components) {
          validateComponents(roleConfig.components, `${prefix}.components`, errors);
        }
        if (roleConfig.componentValues) {
          validateComponentValues(roleConfig.componentValues, `${prefix}.componentValues`, errors);
        }
        if (roleConfig.addons) {
          validateAddons(roleConfig.addons, `${prefix}.addons`, errors);
        }
      }
    }
  }

  if (mesh.clusters) {
    if (!Array.isArray(mesh.clusters)) {
      errors.push('spec.mesh.clusters must be an array');
    } else {
      for (let i = 0; i < mesh.clusters.length; i++) {
        const entry = mesh.clusters[i];
        const prefix = `spec.mesh.clusters[${i}]`;
        if (!entry || typeof entry !== 'object') {
          errors.push(`${prefix}: must be an object with a 'name' field`);
          continue;
        }
        if (!entry.name) {
          errors.push(`${prefix}: missing required field: name`);
        }
        if (entry.components) {
          validateComponents(entry.components, `${prefix}.components`, errors);
        }
        if (entry.additionalComponents) {
          validateComponents(entry.additionalComponents, `${prefix}.additionalComponents`, errors);
        }
        if (entry.componentValues) {
          validateComponentValues(entry.componentValues, `${prefix}.componentValues`, errors);
        }
      }
    }
  }
}

function validateCertificates(certs, errors) {
  if (typeof certs !== 'object' || Array.isArray(certs)) {
    errors.push('spec.mesh.certificates must be an object');
    return;
  }
  if (certs.mode && !VALID_CERT_MODES.includes(certs.mode)) {
    errors.push(
      `Invalid certificates.mode: ${certs.mode}. Valid values: ${VALID_CERT_MODES.join(', ')}`
    );
  }
}

function validateOperator(operator, errors) {
  if (typeof operator !== 'object' || Array.isArray(operator)) {
    errors.push('spec.mesh.operator must be an object');
    return;
  }
  if (operator.scalingProfile && !VALID_SCALING_PROFILES.includes(operator.scalingProfile)) {
    errors.push(
      `Invalid operator.scalingProfile: ${operator.scalingProfile}. Valid values: ${VALID_SCALING_PROFILES.join(', ')}`
    );
  }
}

function validateComponents(components, prefix, errors) {
  if (!Array.isArray(components)) {
    errors.push(`${prefix} must be an array`);
    return;
  }
  for (let i = 0; i < components.length; i++) {
    const comp = components[i];
    if (typeof comp === 'string') {
      if (!VALID_COMPONENTS.includes(comp)) {
        errors.push(
          `${prefix}[${i}]: Invalid component: ${comp}. Valid values: ${VALID_COMPONENTS.join(', ')}`
        );
      }
    } else if (comp && typeof comp === 'object') {
      if (!comp.name) {
        errors.push(`${prefix}[${i}]: Missing required field: name`);
      } else if (!VALID_COMPONENTS.includes(comp.name)) {
        errors.push(
          `${prefix}[${i}]: Invalid component name: ${comp.name}. Valid values: ${VALID_COMPONENTS.join(', ')}`
        );
      }
    } else {
      errors.push(`${prefix}[${i}]: Must be a string or object with 'name' field`);
    }
  }
}

function validateComponentValues(componentValues, prefix, errors) {
  if (typeof componentValues !== 'object' || Array.isArray(componentValues)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  for (const key of Object.keys(componentValues)) {
    if (!VALID_COMPONENTS.includes(key)) {
      errors.push(
        `${prefix}: Invalid component key: ${key}. Valid values: ${VALID_COMPONENTS.join(', ')}`
      );
    }
  }
}

function validateAddonsList(addons, prefix, errors) {
  for (let i = 0; i < addons.length; i++) {
    const addon = addons[i];
    if (typeof addon === 'string') continue;
    if (!addon || typeof addon !== 'object') {
      errors.push(`${prefix}[${i}]: Must be a string or object with 'name' field`);
    } else if (!addon.name) {
      errors.push(`${prefix}[${i}]: Missing required field: name`);
    }
  }
}

function validateAddons(addons, prefix, errors) {
  if (addons === undefined || addons === null) return;

  // New object format: { global: [...], clusters: [...] }
  if (!Array.isArray(addons) && typeof addons === 'object') {
    if (addons.global !== undefined) {
      if (!Array.isArray(addons.global)) {
        errors.push(`${prefix}.global must be an array`);
      } else {
        validateAddonsList(addons.global, `${prefix}.global`, errors);
      }
    }
    if (addons.clusters !== undefined) {
      if (!Array.isArray(addons.clusters)) {
        errors.push(`${prefix}.clusters must be an array`);
      } else {
        for (let i = 0; i < addons.clusters.length; i++) {
          const entry = addons.clusters[i];
          const entryPrefix = `${prefix}.clusters[${i}]`;
          if (!entry || typeof entry !== 'object') {
            errors.push(`${entryPrefix}: Must be an object with 'name' and 'addons' fields`);
          } else {
            if (!entry.name) errors.push(`${entryPrefix}: Missing required field: name`);
            if (entry.addons !== undefined) {
              if (!Array.isArray(entry.addons)) {
                errors.push(`${entryPrefix}.addons must be an array`);
              } else {
                validateAddonsList(entry.addons, `${entryPrefix}.addons`, errors);
              }
            }
          }
        }
      }
    }
    return;
  }

  // Old array format (used for role-level addons)
  if (!Array.isArray(addons)) {
    errors.push(`${prefix} must be an array or an object with 'global' and/or 'clusters' keys`);
    return;
  }
  validateAddonsList(addons, prefix, errors);
}

export const ProfileSchema = {
  validate(profile) {
    const errors = [];

    if (!profile.apiVersion) {
      errors.push('Missing required field: apiVersion');
    } else if (profile.apiVersion !== 'agentic.demo/v1') {
      errors.push(`Invalid apiVersion: ${profile.apiVersion}. Expected: agentic.demo/v1`);
    }

    if (!profile.kind) {
      errors.push('Missing required field: kind');
    } else if (profile.kind !== 'Profile') {
      errors.push(`Invalid kind: ${profile.kind}. Expected: Profile`);
    }

    if (!profile.metadata) {
      errors.push('Missing required field: metadata');
    } else if (!profile.metadata.name) {
      errors.push('Missing required field: metadata.name');
    }

    if (!profile.spec) {
      errors.push('Missing required field: spec');
    } else {
      validateMesh(profile.spec.mesh, errors);
      validateAddons(profile.spec.addons, 'spec.addons', errors);
    }

    return { valid: errors.length === 0, errors };
  },

  getMesh(profile) {
    return profile.spec?.mesh || null;
  },

  getBaseComponents(profile) {
    return profile.spec?.mesh?.components || [...DEFAULT_COMPONENTS];
  },

  normalizeComponents(components) {
    const names = [];
    const componentValues = {};
    for (const comp of components) {
      if (typeof comp === 'string') {
        names.push(comp);
      } else if (comp && typeof comp === 'object' && comp.name) {
        names.push(comp.name);
        if (comp.values) {
          componentValues[comp.name] = comp.values;
        }
      }
    }
    return { names, componentValues };
  },

  getRoles(profile) {
    return profile.spec?.mesh?.roles || {};
  },

  getRoleConfig(profile, roleName) {
    return profile.spec?.mesh?.roles?.[roleName] || null;
  },

  getClusterOverrides(profile) {
    return profile.spec?.mesh?.clusters || [];
  },

  getClusterOverride(profile, clusterName) {
    const clusters = profile.spec?.mesh?.clusters;
    if (!Array.isArray(clusters)) return null;
    return clusters.find(c => c.name === clusterName) || null;
  },

  getBaseAddons(profile) {
    const addons = profile.spec?.addons;
    if (!addons) return [];
    if (Array.isArray(addons)) return addons;
    return addons.global || [];
  },

  getClusterAddons(profile, clusterName) {
    const addons = profile.spec?.addons;
    if (!addons || Array.isArray(addons)) return [];
    const clusters = addons.clusters || [];
    const entry = clusters.find(c => c.name === clusterName);
    return entry?.addons || [];
  },

  getAllClusterAddons(profile) {
    const addons = profile.spec?.addons;
    if (!addons || Array.isArray(addons)) return [];
    return addons.clusters || [];
  },

  getIstioVersion(profile) {
    return profile.spec?.mesh?.istioVersion || null;
  },

  getGatewayApiVersion(profile) {
    return profile.spec?.mesh?.gatewayApiVersion || null;
  },

  getMeshProfile(profile) {
    return profile.spec?.mesh?.profile || 'ambient';
  },

  getInstallMethod(profile) {
    return profile.spec?.mesh?.installMethod || 'helm';
  },

  getCertificates(profile) {
    return profile.spec?.mesh?.certificates || {};
  },

  getCertMode(profile) {
    return profile.spec?.mesh?.certificates?.mode || 'self-signed';
  },

  getInfra(profile) {
    return profile.spec?.infra || null;
  },

  getEnvironment(profile) {
    return profile.spec?.environment || null;
  },

  getImageConfig(profile) {
    return profile.spec?.mesh?.image || {};
  },

  getOperatorConfig(profile) {
    return profile.spec?.mesh?.operator || {};
  },

  getServiceMeshControllerSpec(profile) {
    return profile.spec?.mesh?.serviceMeshController || {};
  },

  getZtunnelEnv(profile) {
    return profile.spec?.mesh?.ztunnelEnv || [];
  },

  hasRoles(profile) {
    const roles = profile.spec?.mesh?.roles;
    return roles && typeof roles === 'object' && Object.keys(roles).length > 0;
  },

  getPeeringMethod(profile) {
    return profile.spec?.mesh?.peering || 'helm';
  },

  getValidComponents() {
    return [...VALID_COMPONENTS];
  },
};
