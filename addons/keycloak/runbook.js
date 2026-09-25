// addons/keycloak/runbook.js
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));

// tpl: return v if it's a real value (not an unresolved {{...}} template), otherwise fb
const tpl = (v, fb) => (v && !/\{\{/.test(v) ? v : fb);

export function envVarsFor(addonCfg, _clusterName) {
  const vars = [
    {
      name: 'KEYCLOAK_ADMIN_USERNAME',
      description: 'Keycloak master realm bootstrap admin username',
      required: true,
    },
    {
      name: 'KEYCLOAK_ADMIN_PASSWORD',
      description: 'Keycloak master realm bootstrap admin password',
      required: true,
    },
    {
      name: 'KEYCLOAK_POSTGRES_USER',
      description: "Postgres superuser backing Keycloak's DB",
      required: true,
    },
    {
      name: 'KEYCLOAK_POSTGRES_PASSWORD',
      description: 'Postgres superuser password',
      required: true,
    },
  ];
  if (addonCfg?.config?.soloUiClients?.enabled) {
    vars.push({
      name: 'SOLO_UI_DEFAULT_PASSWORD',
      description: 'Solo UI demo bootstrap password (solo-admin/solo-reader/solo-writer)',
      required: true,
    });
  }
  if ((addonCfg?.config?.realms || []).some(r => r.realm === 'grafana')) {
    vars.push(
      {
        name: 'GRAFANA_REALM_ADMIN_USERNAME',
        description: "Grafana OIDC demo admin username (default: 'grafana-admin')",
        required: false,
      },
      {
        name: 'GRAFANA_REALM_ADMIN_PASSWORD',
        description: 'Grafana OIDC demo admin password',
        required: true,
      }
    );
  }
  const realmPasswordVars = [
    ['kagent', 'KAGENT_REALM_DEFAULT_PASSWORD', 'kagent-admin/writer/reader bootstrap password'],
    [
      'agentregistry',
      'AGENTREGISTRY_REALM_DEFAULT_PASSWORD',
      'agentregistry demo user bootstrap password',
    ],
  ];
  for (const [realmName, envVar, description] of realmPasswordVars) {
    if ((addonCfg?.config?.realms || []).some(r => r.realm === realmName)) {
      vars.push({ name: envVar, description, required: true });
    }
  }
  for (const realm of addonCfg?.config?.realms || []) {
    for (const idp of realm.identityProviders || []) {
      if (idp.clientSecretEnvVar) {
        vars.push({
          name: idp.clientSecretEnvVar,
          description: `Client secret for identity provider '${idp.alias}' brokered into realm '${realm.realm}'`,
          required: true,
        });
      }
    }
  }
  return vars;
}

const DEFAULT_KEYCLOAK_VERSION = '26.7.3';
const DEFAULT_POSTGRES_VERSION = '18.2-alpine';

// Values needed to resolve the embedded YAML templates — computable from addonCfg
// alone (no env/profile needed), so both generate() and cleanup() can share it.
function _templateValues(addonCfg) {
  const cfg = addonCfg.config || {};
  return {
    ns: addonCfg.namespace || 'keycloak',
    hostname: tpl(cfg.hostname, null) || '$KEYCLOAK_HOSTNAME',
    tlsSecretName: tpl(cfg.tls?.secretName, null) || 'keycloak-tls',
    keycloakImage: cfg.keycloakImage
      ? `${cfg.keycloakImage}:$KEYCLOAK_VERSION`
      : 'quay.io/keycloak/keycloak:$KEYCLOAK_VERSION',
    storageClassName: cfg.postgres?.persistentVolume?.storageClass || 'standard',
    postgresPvcSize: cfg.postgres?.persistentVolume?.size || '5Gi',
  };
}

// Substitute template vars in embedded YAML files. Credentials and versions render
// as shell variable references so the generated commands read them from the
// operator's environment instead of baking environment-specific values into the
// runbook.
function _fillYaml(s, values) {
  const { ns, hostname, tlsSecretName, keycloakImage, storageClassName, postgresPvcSize } = values;
  return s
    .replaceAll("'{{NAMESPACE}}'", ns)
    .replaceAll('"{{NAMESPACE}}"', ns)
    .replaceAll('{{NAMESPACE}}', ns)
    .replaceAll("'{{HOSTNAME}}'", hostname)
    .replaceAll('"{{HOSTNAME}}"', hostname)
    .replaceAll('{{HOSTNAME}}', hostname)
    .replaceAll("'{{TLS_SECRET_NAME}}'", tlsSecretName)
    .replaceAll('"{{TLS_SECRET_NAME}}"', tlsSecretName)
    .replaceAll('{{TLS_SECRET_NAME}}', tlsSecretName)
    .replaceAll('{{POSTGRES_VERSION}}', '$POSTGRES_VERSION')
    .replaceAll('{{KEYCLOAK_VERSION}}', '$KEYCLOAK_VERSION')
    .replaceAll("'{{KEYCLOAK_IMAGE}}'", `'${keycloakImage}'`)
    .replaceAll('"{{KEYCLOAK_IMAGE}}"', `'${keycloakImage}'`)
    .replaceAll('{{KEYCLOAK_IMAGE}}', keycloakImage)
    .replaceAll("'{{STORAGE_CLASS_NAME}}'", storageClassName)
    .replaceAll('"{{STORAGE_CLASS_NAME}}"', storageClassName)
    .replaceAll('{{STORAGE_CLASS_NAME}}', storageClassName)
    .replaceAll("'{{POSTGRES_PVC_SIZE}}'", postgresPvcSize)
    .replaceAll('"{{POSTGRES_PVC_SIZE}}"', postgresPvcSize)
    .replaceAll('{{POSTGRES_PVC_SIZE}}', postgresPvcSize)
    .replaceAll('{{ADMIN_USERNAME}}', '$KEYCLOAK_ADMIN_USERNAME')
    .replaceAll('{{ADMIN_PASSWORD}}', '$KEYCLOAK_ADMIN_PASSWORD')
    .replaceAll('{{POSTGRES_USER}}', '$KEYCLOAK_POSTGRES_USER')
    .replaceAll('{{POSTGRES_PASSWORD}}', '$KEYCLOAK_POSTGRES_PASSWORD');
}

export function envExportsFor(addonCfg, _profile, env) {
  const cfg = addonCfg.config || {};
  const hostname = tpl(cfg.hostname, env.spec.domains?.keycloak) || 'keycloak.example.com';
  const keycloakVersion =
    addonCfg.version ||
    addonCfg.keycloakVersion ||
    cfg.version ||
    cfg.keycloakVersion ||
    DEFAULT_KEYCLOAK_VERSION;
  const postgresVersion =
    addonCfg.postgresVersion || cfg.postgresVersion || DEFAULT_POSTGRES_VERSION;
  const exports = [
    { name: 'KEYCLOAK_HOSTNAME', value: hostname, comment: 'Keycloak public hostname' },
    {
      name: 'KEYCLOAK_NAMESPACE',
      value: addonCfg.namespace || 'keycloak',
      comment: 'Keycloak namespace',
    },
    { name: 'KEYCLOAK_VERSION', value: keycloakVersion, comment: 'Keycloak container image tag' },
    { name: 'POSTGRES_VERSION', value: postgresVersion, comment: 'PostgreSQL container image tag' },
  ];

  const soloUiClients = cfg.soloUiClients;
  if (soloUiClients?.enabled) {
    exports.push({
      name: 'SOLO_UI_ADMIN_USER',
      value: 'solo-admin',
      comment:
        'Solo UI demo admin username (Keycloak solo-ui realm); password is `$SOLO_UI_DEFAULT_PASSWORD`',
    });
  }

  return exports;
}

export async function generate(_subIndex, addonCfg, clusterName, profile, env) {
  const [postgresYamlRaw, keycloakYamlRaw] = await Promise.all([
    fs.promises.readFile(join(__dir, 'config/postgres.yaml'), 'utf8'),
    fs.promises.readFile(join(__dir, 'config/keycloak.yaml'), 'utf8'),
  ]);

  const cfg = addonCfg.config || {};
  const values = _templateValues(addonCfg);
  const { ns, hostname, tlsSecretName } = values;
  const protocol = tpl(cfg.protocol, null) || 'https';

  const tlsEnabled = cfg.tls?.enabled !== false;
  const createCertificate = cfg.tls?.createCertificate !== false;
  const issuerName = tpl(cfg.tls?.clusterIssuerName, null) || 'selfsigned-issuer';
  const certOrg = tpl(cfg.tls?.organization, null) || 'solo.io';

  // sourceRanges mixes a real env value ({{env.security.vpnSourceRanges}}, resolvable here
  // since `env` is the loaded environment spec) with per-cluster infra-state tokens (NAT
  // gateway IPs) this generator can't resolve — those fall back to a readable placeholder
  // instead of leaving `{{...}}` literally in the runbook.
  const vpnSourceRanges = env.spec?.security?.vpnSourceRanges || [];
  const infraTokenMatch = r => r?.match?.(/infra\.clusters\.(\w+)\.network\.natGatewayIp/);
  const sourceRangesList = Array.isArray(cfg.sourceRanges) ? cfg.sourceRanges : [cfg.sourceRanges];
  const sourceRanges = sourceRangesList
    .flat()
    .filter(Boolean)
    .flatMap(r => {
      if (r === '{{env.security.vpnSourceRanges}}') return vpnSourceRanges;
      const infraMatch = infraTokenMatch(r);
      if (infraMatch) return `<${infraMatch[1]}-nat-gateway-ip>/32`;
      return tpl(r, null) || r;
    })
    .join(',');

  const fillYaml = s => _fillYaml(s, values);

  const postgresYaml = fillYaml(postgresYamlRaw);
  const keycloakYaml = fillYaml(keycloakYamlRaw);

  // Collect all addon names defined anywhere in the profile (global + per-cluster)
  const allProfileAddonNames = new Set();
  for (const g of profile?.spec?.addons?.global || []) {
    allProfileAddonNames.add(typeof g === 'string' ? g : g.name);
  }
  for (const clusterDef of profile?.spec?.addons?.clusters || []) {
    for (const a of clusterDef.addons || []) {
      allProfileAddonNames.add(typeof a === 'string' ? a : a.name);
    }
  }

  // Collect addon names installed on this specific cluster
  const thisClusterDef = (profile?.spec?.addons?.clusters || []).find(c => c.name === clusterName);
  const thisClusterAddonNames = new Set(
    (thisClusterDef?.addons || []).map(a => (typeof a === 'string' ? a : a.name))
  );

  // Filter realms: if realm name matches a known addon, only include if that addon is on this cluster
  const realms = (cfg.realms || []).filter(
    r => !allProfileAddonNames.has(r.realm) || thisClusterAddonNames.has(r.realm)
  );
  const soloUiClients = cfg.soloUiClients || null;

  let tlsSection = '';
  if (tlsEnabled && createCertificate) {
    tlsSection = `

Create TLS certificate for Keycloak (cert-manager):

\`\`\`bash
kubectl apply -f - <<EOF
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: ${tlsSecretName}
  namespace: ${ns}
spec:
  secretName: ${tlsSecretName}
  issuerRef:
    name: ${issuerName}
    kind: ClusterIssuer
  commonName: ${hostname}
  dnsNames:
    - ${hostname}
  subject:
    organizations:
      - ${certOrg}
    organizationalUnits:
      - keycloak
EOF
\`\`\`

Wait for the certificate to be issued:

\`\`\`bash
kubectl wait certificate/${tlsSecretName} -n ${ns} \\
  --for=condition=Ready --timeout=120s
\`\`\`
`;
  }

  const baseUrl = `${protocol}://${hostname}`;

  // Helper — builds the "Configure realm `<name>`" snippet
  const makeRealmSnippet = realm => {
    const clients = realm.clients || [];
    const users = realm.users || [];
    const groups = realm.groups || [];
    const identityProviders = realm.identityProviders || [];

    const idpLines = identityProviders
      .map(
        idp => `      curl -s -X POST "$KEYCLOAK_URL/admin/realms/${realm.realm}/identity-provider/instances" \\
        -H "Authorization: Bearer $ACCESS_TOKEN" \\
        -H "Content-Type: application/json" \\
        -d '{"alias":"${idp.alias}","displayName":"${idp.displayName || idp.alias}","providerId":"oidc","enabled":true,"trustEmail":true,"config":{"clientId":"${idp.clientId}","clientSecret":"'"$${idp.clientSecretEnvVar}"'","authorizationUrl":"${idp.authorizationUrl}","tokenUrl":"${idp.tokenUrl}","jwksUrl":"${idp.jwksUrl}","issuer":"${idp.issuer}","useJwksUrl":"true","validateSignature":"true","clientAuthMethod":"client_secret_post","syncMode":"IMPORT","defaultScope":"${idp.defaultScope || 'openid profile email'}"}}'`
      )
      .join('\n\n');

    const groupLines = groups
      .map(
        g => `      curl -s -X POST "$KEYCLOAK_URL/admin/realms/${realm.realm}/groups" \\
        -H "Authorization: Bearer $ACCESS_TOKEN" \\
        -H "Content-Type: application/json" \\
        -d '{"name":"${g}"}'`
      )
      .join('\n\n');

    const clientLines = clients
      .map(c => {
        const isPublic = c.type === 'public';
        return `      curl -s -X POST "$KEYCLOAK_URL/admin/realms/${realm.realm}/clients" \\
        -H "Authorization: Bearer $ACCESS_TOKEN" \\
        -H "Content-Type: application/json" \\
        -d '{"clientId":"${c.clientId}","publicClient":${isPublic},"enabled":true}'`;
      })
      .join('\n\n');

    const isGrafanaRealm = realm.realm === 'grafana';
    // Realms whose password must come from an env var rather than being rendered
    // literally into the generated runbook.
    const REALM_PASSWORD_ENV_VARS = {
      kagent: 'KAGENT_REALM_DEFAULT_PASSWORD',
      agentregistry: 'AGENTREGISTRY_REALM_DEFAULT_PASSWORD',
    };
    const passwordEnvVar = REALM_PASSWORD_ENV_VARS[realm.realm];
    const userLines = users
      .map(u => {
        if (isGrafanaRealm) {
          return `      curl -s -X POST "$KEYCLOAK_URL/admin/realms/${realm.realm}/users" \\
        -H "Authorization: Bearer $ACCESS_TOKEN" \\
        -H "Content-Type: application/json" \\
        -d '{"username":"'"\${GRAFANA_REALM_ADMIN_USERNAME:-grafana-admin}"'","email":"${u.email || ''}","enabled":true,"credentials":[{"type":"password","value":"'"$GRAFANA_REALM_ADMIN_PASSWORD"'","temporary":false}]}'`;
        }
        const passwordValue = passwordEnvVar
          ? `'"$${passwordEnvVar}"'`
          : realm.defaultPassword || '';
        return `      curl -s -X POST "$KEYCLOAK_URL/admin/realms/${realm.realm}/users" \\
        -H "Authorization: Bearer $ACCESS_TOKEN" \\
        -H "Content-Type: application/json" \\
        -d '{"username":"${u.username}","email":"${u.email || ''}","enabled":true,"credentials":[{"type":"password","value":"${passwordValue}","temporary":false}]}'`;
      })
      .join('\n\n');

    return `
**Configure realm \`${realm.realm}\`** (${clients.length} clients, ${users.length} users${identityProviders.length > 0 ? `, ${identityProviders.length} identity provider(s)` : ''}):

\`\`\`bash
KEYCLOAK_URL="${baseUrl}"
ACCESS_TOKEN=$(curl -s -X POST "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" \\
  -d "client_id=admin-cli&grant_type=password&username=$KEYCLOAK_ADMIN_USERNAME&password=$KEYCLOAK_ADMIN_PASSWORD" \\
  | jq -r '.access_token')

# Create realm
curl -s -X POST "$KEYCLOAK_URL/admin/realms" \\
  -H "Authorization: Bearer $ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"realm":"${realm.realm}","enabled":true,"defaultLocale":"en"}'
${
  identityProviders.length > 0
    ? `
# Configure identity providers (broker) -- UNVERIFIED: registers the broker Keycloak
# needs to validate an externally issued token's signature/issuer; whether a
# runtime token-exchange call actually resolves through Keycloak's
# external-token-exchange path has not been confirmed against a real tenant.
${idpLines}`
    : ''
}${
      groups.length > 0
        ? `
# Create groups
${groupLines}`
        : ''
    }${
      clients.length > 0
        ? `
# Create clients
${clientLines}`
        : ''
    }${
      users.length > 0
        ? `
# Create users
${userLines}`
        : ''
    }
\`\`\`
`;
  };

  const realmSnippets = realms.map(makeRealmSnippet).join('\n');

  // Dedicated agentregistry realm gate — only rendered when agentregistry addon is on this cluster
  let agentregistryRealmSnippet = '';
  const arCfg = cfg.agentregistryRealm;
  if (arCfg?.enabled && thisClusterAddonNames.has('agentregistry')) {
    agentregistryRealmSnippet = makeRealmSnippet({
      realm: 'agentregistry',
      groups: arCfg.groups || [],
      clients: arCfg.clients || [],
      users: arCfg.users || [],
      defaultPassword: arCfg.defaultPassword,
    });
  }

  let soloUiSection = '';
  if (soloUiClients?.enabled) {
    const suiRealm = soloUiClients.realm || 'solo-ui';
    const suiHostname = tpl(soloUiClients.hostname, env.spec.domains?.soloUi) || '';
    const suiPassword = '$SOLO_UI_DEFAULT_PASSWORD';
    const suiUsers = ['solo-admin', 'solo-reader', 'solo-writer'];
    const suiUserLines = suiUsers
      .map(
        u => `curl -s -X POST "$KEYCLOAK_URL/admin/realms/${suiRealm}/users" \\
  -H "Authorization: Bearer $ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"username":"${u}","enabled":true,"credentials":[{"type":"password","value":"'"$SOLO_UI_DEFAULT_PASSWORD"'","temporary":false}]}'`
      )
      .join('\n\n');
    soloUiSection = `

**Configure Solo UI realm \`${suiRealm}\`**:

\`\`\`bash
KEYCLOAK_URL="${baseUrl}"
ACCESS_TOKEN=$(curl -s -X POST "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" \\
  -d "client_id=admin-cli&grant_type=password&username=$KEYCLOAK_ADMIN_USERNAME&password=$KEYCLOAK_ADMIN_PASSWORD" \\
  | jq -r '.access_token')

curl -s -X POST "$KEYCLOAK_URL/admin/realms" \\
  -H "Authorization: Bearer $ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"realm":"${suiRealm}","enabled":true}'

# Backend client (confidential)
curl -s -X POST "$KEYCLOAK_URL/admin/realms/${suiRealm}/clients" \\
  -H "Authorization: Bearer $ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"clientId":"${soloUiClients.backendClientId || 'solo-ui-backend'}","secret":"${soloUiClients.backendClientSecret || 'solo-ui-backend-secret'}","publicClient":false,"enabled":true,"redirectUris":["${suiHostname}/*"]}'

# Frontend client (public, PKCE)
curl -s -X POST "$KEYCLOAK_URL/admin/realms/${suiRealm}/clients" \\
  -H "Authorization: Bearer $ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"clientId":"${soloUiClients.frontendClientId || 'solo-ui-frontend'}","publicClient":true,"enabled":true,"redirectUris":["${suiHostname}/*"]}'

# Demo users (password: ${suiPassword})
${suiUserLines}
\`\`\`
`;
  }

  return `Install Keycloak on the **${clusterName}** cluster as OIDC provider. Deployed via raw Kubernetes manifests (PostgreSQL \`$POSTGRES_VERSION\` + Keycloak \`$KEYCLOAK_VERSION\`) — no Helm chart.

\`\`\`bash
kubectl create namespace ${ns} --dry-run=client -o yaml | kubectl apply -f -
\`\`\`
${tlsSection}
Apply PostgreSQL (ServiceAccount, Secret, PVC, Service, Deployment):

\`\`\`bash
kubectl apply -n ${ns} -f - <<EOF
${postgresYaml.trimEnd()}
EOF
\`\`\`

Wait for PostgreSQL to be ready:

\`\`\`bash
kubectl wait --for=condition=Ready pod -l app=postgres -n ${ns} --timeout=300s
\`\`\`

Initialize the Keycloak database:

\`\`\`bash
kubectl exec -n ${ns} deploy/postgres -- psql -U $KEYCLOAK_POSTGRES_USER -d postgres -c "CREATE DATABASE keycloak;"
kubectl exec -n ${ns} deploy/postgres -- psql -U $KEYCLOAK_POSTGRES_USER -d postgres -c "CREATE USER keycloak WITH PASSWORD 'password';"
kubectl exec -n ${ns} deploy/postgres -- psql -U $KEYCLOAK_POSTGRES_USER -d postgres -c "GRANT ALL PRIVILEGES ON DATABASE keycloak TO keycloak;"
\`\`\`

Apply Keycloak (Deployment + Service):

\`\`\`bash
kubectl apply -n ${ns} -f - <<EOF
${keycloakYaml.trimEnd()}
EOF
\`\`\`
${
  thisClusterAddonNames.has('external-dns')
    ? `
Annotate the Service for external-dns (the Service manifest has no hostname of its own — external-dns needs this to create the DNS record):

\`\`\`bash
kubectl annotate service keycloak -n ${ns} "external-dns.alpha.kubernetes.io/hostname=${hostname}" --overwrite
\`\`\`
`
    : ''
}${
    sourceRanges
      ? `
Gate the NLB to an allowed CIDR list (the AWS Load Balancer Controller reads this on the Service and rewrites its managed security group; \`nlb-target-type=ip\` requires client-IP preservation to be re-enabled or the CIDR gate is silently ignored):

\`\`\`bash
kubectl annotate service keycloak -n ${ns} \\
  "service.beta.kubernetes.io/aws-load-balancer-type=external" \\
  "service.beta.kubernetes.io/aws-load-balancer-nlb-target-type=ip" \\
  "service.beta.kubernetes.io/aws-load-balancer-scheme=internet-facing" \\
  "service.beta.kubernetes.io/aws-load-balancer-target-group-attributes=preserve_client_ip.enabled=true" \\
  "service.beta.kubernetes.io/load-balancer-source-ranges=${sourceRanges}" \\
  --overwrite
\`\`\`
`
      : ''
  }
Wait for Keycloak to be ready:

\`\`\`bash
kubectl wait --for=condition=Ready pod -l app=keycloak -n ${ns} --timeout=600s
\`\`\`

Verify Keycloak is reachable:

\`\`\`bash
curl -sk ${baseUrl}/realms/master | jq '.realm'
# Expected: "master"
\`\`\`
${realmSnippets}${agentregistryRealmSnippet}${soloUiSection}`;
}

export async function cleanup(addonCfg, clusterName) {
  const values = _templateValues(addonCfg);
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;
  // Keycloak and its Postgres backing store both live entirely in this namespace —
  // deleting it removes everything without needing to re-list each resource.
  return `\`\`\`bash
kubectl --context ${ctx} delete namespace ${values.ns} --ignore-not-found=true
\`\`\``;
}
