// addons/solo-ui/runbook.js
import { resolveRunbookTemplates } from '../../src/lib/runbook-adapters/template-vars.js';

// tpl: return v if it's a real value (not an unresolved {{...}} template), otherwise fb
const tpl = (v, fb) => (v && !/\{\{/.test(v) ? v : fb);

// Product tab path prefixes, per kagent-enterprise's product-types.ts (mirrors index.js).
const PRODUCT_PATH_PREFIXES = { kagent: 'ke', agentgateway: 'age', mesh: 'ie' };

/** Merge profile addon `config:` block (same flattening as installer.js). */
const addonSettings = addonCfg =>
  addonCfg?.config && typeof addonCfg.config === 'object'
    ? { ...addonCfg, ...addonCfg.config }
    : addonCfg;

export function envVarsFor(_addonCfg, _clusterName) {
  return [
    {
      name: 'ENTERPRISE_ISTIO_LICENSE',
      description: 'Solo.io license key (also used for Solo UI)',
      required: true,
    },
  ];
}

export function envExportsFor(addonCfg, _profile, env) {
  const addon = addonSettings(addonCfg);
  const mode = addon.mode || 'management';
  if (mode === 'relay') return [];
  const hostname = tpl(addon.hostname, env.spec.domains?.core?.soloUi) || 'soloui.example.com';
  const version = resolveRunbookTemplates(addon.version, { env }) || '0.4.3';
  return [
    { name: 'SOLO_UI_VERSION', value: version, comment: 'Solo UI chart version' },
    { name: 'SOLO_UI_HOSTNAME', value: hostname, comment: 'Solo UI public hostname' },
    {
      name: 'SOLO_UI_NAMESPACE',
      value: addon.namespace || 'solo-enterprise',
      comment: 'Solo UI namespace',
    },
  ];
}

export async function generate(_subIndex, addonCfg, clusterName, _profile, env) {
  const mode = addonSettings(addonCfg).mode || 'management';
  if (mode === 'relay') return _generateRelay(addonCfg, clusterName, env);
  return _generateManagement(addonCfg, clusterName, env);
}

function _generateManagement(addonCfg, clusterName, env) {
  const addon = addonSettings(addonCfg);
  const ns = addon.namespace || 'solo-enterprise';
  const hostname = tpl(addon.hostname, null) || '$SOLO_UI_HOSTNAME';
  const oidc = addon.oidc || {};
  const storageClass = addon.clickhouse?.persistentVolume?.storageClass || 'gp3';
  const storageSize = addon.clickhouse?.persistentVolume?.size || '100Gi';
  const products = addon.products || {};
  const telNs = addon.telemetryNamespace || 'telemetry';
  const tls = addon.tls || {};

  const oidcIssuerUrl = resolveRunbookTemplates(oidc.issuerUrl, { env }) || '';

  // OCI chart URLs — no helm repo add needed
  const crdsChartOci =
    'oci://us-docker.pkg.dev/solo-public/solo-enterprise-helm/charts/management-crds';
  const mgmtChartOci = 'oci://us-docker.pkg.dev/solo-public/solo-enterprise-helm/charts/management';

  // OIDC secret + helm flags (index.js pattern: clientSecret in k8s secret, not direct helm flag)
  const oidcSecretBlock = oidc.enabled
    ? `
Create OIDC backend client secret:

\`\`\`bash
kubectl create secret generic ui-backend-oidc-secret \\
  --from-literal=clientSecret="${oidc.backendClientSecret || ''}" \\
  --namespace ${ns} \\
  --dry-run=client -o yaml \\
  | kubectl apply -f -
\`\`\`
`
    : '';

  const oidcArgs = oidc.enabled
    ? [
        `  --set oidc.issuer="${oidcIssuerUrl}"`,
        `  --set ui.backend.oidc.clientId="${oidc.backendClientId || ''}"`,
        `  --set ui.backend.oidc.secretRef=ui-backend-oidc-secret`,
        `  --set ui.frontend.oidc.clientId="${oidc.frontendClientId || ''}"`,
        `  --set rbac.roleMapping.roleMappings.admins=global.Admin`,
        `  --set rbac.roleMapping.roleMappings.readers=global.Reader`,
        `  --set rbac.roleMapping.roleMappings.writers=global.Writer`,
      ]
    : [];

  // The chart has no way to mount a custom CA into ui-backend, so if Keycloak's cert isn't
  // from a publicly-trusted CA (self-signed, or issued while an ACME rate limit was active),
  // ui-backend's OIDC discovery fails TLS verification and crash-loops. Fix via a post-install
  // patch — confirmed working live: extract Keycloak's CA, mount it, and point SSL_CERT_FILE at it.
  const caTrustBlock = oidc.enabled
    ? `

**If \`ui-backend\` crash-loops with \`tls: failed to verify certificate: x509: certificate signed by unknown authority\` during OIDC discovery:**

Keycloak's certificate isn't signed by a publicly-trusted CA. Mount its CA into \`ui-backend\`'s trust store:

\`\`\`bash
kubectl get secret keycloak-tls -n $KEYCLOAK_NAMESPACE -o jsonpath='{.data.ca\\.crt}' | base64 -d > /tmp/keycloak-ca.crt
kubectl create configmap keycloak-ca -n ${ns} --from-file=ca.crt=/tmp/keycloak-ca.crt --dry-run=client -o yaml \\
  | kubectl apply -f -
kubectl patch deployment solo-enterprise-ui -n ${ns} --type=json \\
  -p '[{"op":"add","path":"/spec/template/spec/volumes/-","value":{"name":"keycloak-ca","configMap":{"name":"keycloak-ca"}}}]'
kubectl patch deployment solo-enterprise-ui -n ${ns} --type=strategic -p '{"spec":{"template":{"spec":{"containers":[{"name":"ui-backend","volumeMounts":[{"name":"keycloak-ca","mountPath":"/etc/ssl/certs/keycloak-ca.pem","subPath":"ca.crt","readOnly":true}],"env":[{"name":"SSL_CERT_FILE","value":"/etc/ssl/certs/keycloak-ca.pem"}]}]}}}}'
\`\`\``
    : '';

  const helmArgs = [
    `  ${mgmtChartOci}`,
    `  --namespace ${ns}`,
    `  --create-namespace`,
    `  --version $SOLO_UI_VERSION`,
    `  --set licensing.licenseKey="$ENTERPRISE_ISTIO_LICENSE"`,
    `  --set management-crds.enabled=false`,
    `  --set ui.hostname=${hostname}`,
    `  --set telemetry.namespace=${telNs}`,
    `  --set clickhouse.persistence.storageClass=${storageClass}`,
    `  --set clickhouse.persistence.size=${storageSize}`,
    ...oidcArgs,
    ...productSetLines(products),
    `  --wait`,
    `  --timeout 10m`,
  ];
  const helmCmd = `helm upgrade --install solo-ui \\\n${helmArgs
    .map(a => `${a} \\`)
    .join('\n')
    .replace(/ \\$/, '')}`;

  // HTTPS resources when TLS is enabled
  let httpsBlock = '';
  if (hostname && tls.enabled) {
    const tlsSecret = tls.secretName || 'solo-ui-tls';
    const tlsIssuer = tls.issuer || 'letsencrypt-dns';
    httpsBlock = `
Apply HTTPS resources (Certificate, Gateway, HTTPRoute):

\`\`\`bash
kubectl apply -f - <<EOF
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: ${tlsSecret}
  namespace: ${ns}
spec:
  secretName: ${tlsSecret}
  issuerRef:
    name: ${tlsIssuer}
    kind: ClusterIssuer
  dnsNames:
    - ${hostname}
EOF

kubectl apply -f - <<EOF
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: solo-enterprise-ui-https
  namespace: ${ns}
spec:
  gatewayClassName: istio
  listeners:
    - name: https
      port: 443
      protocol: HTTPS
      hostname: ${hostname}
      tls:
        mode: Terminate
        certificateRefs:
          - name: ${tlsSecret}
            kind: Secret
      allowedRoutes:
        namespaces:
          from: All
EOF

kubectl apply -f - <<EOF
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: solo-enterprise-ui
  namespace: ${ns}
spec:
  parentRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: solo-enterprise-ui-https
      namespace: ${ns}
  hostnames:
    - ${hostname}
  rules:
    - backendRefs:
        - name: solo-enterprise-ui
          port: 80
      matches:
        - path:
            type: PathPrefix
            value: /
EOF
\`\`\``;
  }

  // Per-product hostname aliases: real URLRewrite to each product's path prefix,
  // since the in-app product switcher is dead code in production builds.
  const productAliases = Array.isArray(addon.productAliases) ? addon.productAliases : [];
  let aliasesBlock = '';
  if (productAliases.length > 0) {
    const issuerName = tls.issuer || 'letsencrypt-dns';
    // Same NLB scheme/source-range annotations as the main gateway (nlbSourceRangeAnnotations
    // in src/lib/common.js) -- without an explicit internet-facing scheme, AWS Load Balancer
    // Controller defaults new Services to internal, unreachable from outside the VPC.
    const sourceRangesList = Array.isArray(addon.sourceRanges)
      ? addon.sourceRanges
      : [addon.sourceRanges];
    const resolvedRanges = sourceRangesList.filter(Boolean).map(r => tpl(r, '<vpn-cidr>'));
    const infrastructureBlock =
      resolvedRanges.length > 0
        ? `  infrastructure:
    annotations:
      service.beta.kubernetes.io/aws-load-balancer-type: external
      service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip
      service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing
      service.beta.kubernetes.io/aws-load-balancer-target-group-attributes: preserve_client_ip.enabled=true
      service.beta.kubernetes.io/load-balancer-source-ranges: "${resolvedRanges.join(',')}"
`
        : '';
    const aliasCmds = productAliases
      .map(({ product, hostname: rawHostname }) => {
        const aliasHostname = resolveRunbookTemplates(rawHostname, { env }) || rawHostname;
        const prefix = PRODUCT_PATH_PREFIXES[product] || product;
        const secretName = `${product}-ui-tls`;
        return `# ${product}: https://${aliasHostname} -> /${prefix}
kubectl apply -f - <<EOF
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: ${secretName}
  namespace: ${ns}
spec:
  secretName: ${secretName}
  issuerRef:
    name: ${issuerName}
    kind: ClusterIssuer
  dnsNames:
    - ${aliasHostname}
EOF

kubectl apply -f - <<EOF
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: ${product}-ui-https
  namespace: ${ns}
spec:
  gatewayClassName: enterprise-agentgateway
  listeners:
    - name: https
      port: 443
      protocol: HTTPS
      hostname: ${aliasHostname}
      tls:
        mode: Terminate
        certificateRefs:
          - name: ${secretName}
            kind: Secret
      allowedRoutes:
        namespaces:
          from: All
${infrastructureBlock}EOF

kubectl apply -f - <<EOF
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: ${product}-ui
  namespace: ${ns}
spec:
  parentRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: ${product}-ui-https
      namespace: ${ns}
  hostnames:
    - ${aliasHostname}
  rules:
    # The SPA is one build with client-side routing -- its static assets are
    # root-relative regardless of product route, so only the bare root path
    # redirects (changing the browser's visible URL to /${prefix}); every other
    # request, including every asset, passes through unmodified below.
    - matches:
        - path:
            type: Exact
            value: /
      filters:
        - type: RequestRedirect
          requestRedirect:
            path:
              type: ReplaceFullPath
              replaceFullPath: /${prefix}
            statusCode: 302
    - backendRefs:
        - name: solo-enterprise-ui
          port: 80
      matches:
        - path:
            type: PathPrefix
            value: /
EOF

kubectl apply -f - <<EOF
apiVersion: enterpriseagentgateway.solo.io/v1alpha1
kind: EnterpriseAgentgatewayPolicy
metadata:
  name: ${product}-ui-cors
  namespace: ${ns}
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: ${product}-ui-https
  traffic:
    cors:
      allowCredentials: true
      allowHeaders:
        - Content-Type
        - Authorization
        - X-Grpc-Web
        - Grpc-Timeout
        - Grpc-Accept-Encoding
        - Grpc-Encoding
        - X-User-Agent
        - Accept
        - Accept-Encoding
        - Accept-Language
        - Cache-Control
        - User-Agent
      allowMethods:
        - GET
        - POST
        - OPTIONS
        - DELETE
      allowOrigins:
        - https://${aliasHostname}
      exposeHeaders:
        - Grpc-Status
        - Grpc-Message
        - Grpc-Status-Details-Bin
        - Content-Type
        - X-Grpc-Web
      maxAge: 86400
EOF`;
      })
      .join('\n\n');

    aliasesBlock = `
Apply per-product hostname aliases (real UI, no in-app switcher needed):

\`\`\`bash
${aliasCmds}
\`\`\``;
  }

  return `Install Solo UI in **management** mode on the **${clusterName}** cluster.

Label namespace for Ambient mesh:

\`\`\`bash
kubectl create namespace ${ns} --dry-run=client -o yaml | kubectl apply -f -
kubectl label namespace ${ns} istio.io/dataplane-mode=ambient --overwrite
\`\`\`
${oidcSecretBlock}
Install management CRDs chart:

\`\`\`bash
helm upgrade --install solo-ui-crds ${crdsChartOci} \\
  --namespace ${ns} \\
  --version $SOLO_UI_VERSION \\
  --create-namespace \\
  --wait \\
  --timeout 5m
\`\`\`

Install Solo UI management chart:

\`\`\`bash
${helmCmd}
\`\`\`
${caTrustBlock}
${httpsBlock}
${aliasesBlock}`;
}

// Flatten a nested object into `--set path=value` lines (mirrors index.js's buildHelmSetArgs).
function productSetLines(products) {
  if (!products) return [];
  const lines = [];
  const flatten = (val, path) => {
    for (const [key, v] of Object.entries(val)) {
      const fullPath = path ? `${path}.${key}` : key;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        flatten(v, fullPath);
      } else {
        lines.push(`  --set ${fullPath}=${v}`);
      }
    }
  };
  flatten(products, 'products');
  return lines;
}

function _generateRelay(addonCfg, clusterName, env) {
  const addon = addonSettings(addonCfg);
  const ns = addon.namespace || 'solo-enterprise';
  const tunnel = addon.tunnel || {};
  const telemetry = addon.telemetry || {};
  // Resolves any {{env.internal.*}} template to the real cross-cluster mesh.internal DNS
  // name (there's no dedicated env var for these — they're derived, not user-configured).
  const tunnelFqdn = resolveRunbookTemplates(tunnel.fqdn, { env }) || '';
  const telemetryFqdn = resolveRunbookTemplates(telemetry.fqdn, { env }) || '';
  // The relay chart's validation.yaml requires at least one products.*.enabled=true.
  const productArgs = productSetLines(addon.products).join(' \\\n');

  // OCI chart URL — no helm repo add needed
  const relayChartOci = 'oci://us-docker.pkg.dev/solo-public/solo-enterprise-helm/charts/relay';

  return `Install Solo UI in **relay** mode on the **${clusterName}** cluster. Connects to the management plane on the east cluster via ambient mesh \`mesh.internal\` DNS.

Label namespace for Ambient mesh:

\`\`\`bash
kubectl create namespace ${ns} --dry-run=client -o yaml | kubectl apply -f -
kubectl label namespace ${ns} istio.io/dataplane-mode=ambient --overwrite
\`\`\`

\`\`\`bash
helm upgrade --install solo-relay ${relayChartOci} \\
  --namespace ${ns} \\
  --create-namespace \\
  --version $SOLO_UI_VERSION \\
  --set tunnel.fqdn="${tunnelFqdn}" \\
  --set tunnel.port=${tunnel.port || 9000} \\
  --set telemetry.fqdn="${telemetryFqdn}" \\
  --set cluster=${clusterName}${productArgs ? ` \\\n${productArgs}` : ''} \\
  --wait \\
  --timeout 5m
\`\`\``;
}

export function cleanup(addonCfg, clusterName) {
  const addon = addonSettings(addonCfg);
  const ns = addon.namespace || 'solo-enterprise';
  const mode = addon.mode || 'management';
  const releases = mode === 'relay' ? 'solo-relay' : 'solo-ui solo-ui-crds';
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;

  const productAliases = Array.isArray(addon.productAliases) ? addon.productAliases : [];
  const aliasCleanup = productAliases
    .map(
      ({
        product,
      }) => `kubectl delete enterpriseagentgatewaypolicy ${product}-ui-cors -n ${ns} --context ${ctx} --ignore-not-found
kubectl delete httproute ${product}-ui -n ${ns} --context ${ctx} --ignore-not-found
kubectl delete gateway ${product}-ui-https -n ${ns} --context ${ctx} --ignore-not-found
kubectl delete certificate ${product}-ui-tls -n ${ns} --context ${ctx} --ignore-not-found`
    )
    .join('\n');

  return `\`\`\`bash
${aliasCleanup ? `${aliasCleanup}\n` : ''}helm uninstall ${releases} -n ${ns} --kube-context ${ctx}
\`\`\``;
}
