// addons/cert-manager/runbook.js

// tpl: return v if it's a real value (not an unresolved {{...}} template), otherwise fb
const tpl = (v, fb) => (v && !/\{\{/.test(v) ? v : fb);

export function envVarsFor(_addonCfg, _clusterName) {
  return [];
}

export function envExportsFor(addonCfg, _profile, env) {
  const exports = [
    {
      name: 'CERT_MANAGER_VERSION',
      value: addonCfg.version || '1.20.2',
      comment: 'cert-manager version',
    },
  ];
  const letsencrypt = addonCfg.config?.letsencrypt;
  if (letsencrypt?.enabled) {
    exports.push({
      name: 'ACME_EMAIL',
      value: tpl(letsencrypt.email, env.spec.acme?.email || '<your-email@example.com>'),
      comment: 'ACME/LetsEncrypt email for certificate issuance',
      hideFromTable: true,
    });
  }
  return exports;
}

export async function generate(_subIndex, addonCfg, clusterName, _profile, _env) {
  const ns = addonCfg.namespace || 'cert-manager';
  const letsencrypt = addonCfg.config?.letsencrypt;
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;

  const selfSignedIssuer = `

Create a self-signed ClusterIssuer (used for bootstrapping and internal certs):

\`\`\`bash
kubectl apply --context ${ctx} -f - <<EOF
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-issuer
spec:
  selfSigned: {}
EOF
\`\`\``;

  let clusterIssuer = selfSignedIssuer;
  if (letsencrypt?.enabled) {
    const email = tpl(letsencrypt.email, null) || '$ACME_EMAIL';
    const region = tpl(letsencrypt.region, null) || '$AWS_REGION';
    clusterIssuer += `

Create the Route53 DNS ClusterIssuer for Let's Encrypt:

\`\`\`bash
kubectl apply --context ${ctx} -f - <<EOF
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-dns
spec:
  acme:
    email: ${email}
    server: https://acme-v02.api.letsencrypt.org/directory
    privateKeySecretRef:
      name: letsencrypt-dns-key
    solvers:
      - dns01:
          route53:
            region: ${region}
EOF
\`\`\``;
  }

  return `Install cert-manager for TLS certificate management on the **${clusterName}** cluster.

\`\`\`bash
helm repo add jetstack https://charts.jetstack.io
helm repo update

helm upgrade --install cert-manager jetstack/cert-manager \\
  --kube-context ${ctx} \\
  --namespace ${ns} \\
  --create-namespace \\
  --version v$CERT_MANAGER_VERSION \\
  --set crds.enabled=true \\
  --wait
\`\`\`
${clusterIssuer}`;
}

export function cleanup(addonCfg, clusterName) {
  const ns = addonCfg.namespace || 'cert-manager';
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;
  return `\`\`\`bash
helm uninstall cert-manager -n ${ns} --kube-context ${ctx}
\`\`\``;
}
