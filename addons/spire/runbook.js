// addons/spire/runbook.js

// Profile addon entries nest their fields under `config:` (flattened onto the addon by
// the real installer before use — see installer.js#installAddons). The runbook pipeline
// doesn't do this flattening itself, so every sidecar that reads config fields must.
function flatten(addonCfg) {
  return addonCfg?.config && typeof addonCfg.config === 'object'
    ? { ...addonCfg, ...addonCfg.config }
    : addonCfg;
}

const DISTINCT_ROOTS_DIR = '/tmp/spire-distinct-roots';

// The runbook pipeline (unlike the real installer's TemplateResolver) never resolves
// {{ cluster.* }} templates in addon config — resolve the one field spire actually uses.
function resolveTrustDomain(value, clusterName) {
  return typeof value === 'string'
    ? value.replace(/\{\{\s*cluster\.name\s*\}\}/g, clusterName)
    : clusterName;
}

export function envVarsFor(_addonCfg, _clusterName) {
  return [];
}

export function envExportsFor(addonCfg, _profile, _env) {
  const cfg = flatten(addonCfg);
  return [
    {
      name: 'SPIRE_VERSION',
      value: cfg.spireVersion || '0.30.0',
      comment: 'SPIRE Helm chart version',
    },
    {
      name: 'SPIRE_CRDS_VERSION',
      value: cfg.spireCrdsVersion || '0.6.0',
      comment: 'SPIRE CRDs Helm chart version',
    },
  ];
}

// Mirrors SpireRootManager (src/lib/multicluster.js): when any cluster's SPIRE config
// requests distinctRoots, every cluster's independent root must exist before any
// cluster's SPIRE install runs, so each one can trust its peers' roots immediately.
export async function generatePreamble(instances, _selection) {
  const targets = instances
    .map(({ addon, clusterName }) => {
      const cfg = flatten(addon);
      return {
        clusterName,
        trustDomain: resolveTrustDomain(cfg.trustDomain || clusterName, clusterName),
        distinctRoots: cfg.distinctRoots === true,
      };
    })
    .filter(t => t.distinctRoots);

  if (targets.length === 0) return null;

  const genBlocks = targets
    .map(
      ({ clusterName, trustDomain }) => `# ${clusterName} (trust domain: ${trustDomain})
mkdir -p ${DISTINCT_ROOTS_DIR}/${trustDomain}
openssl genrsa -out ${DISTINCT_ROOTS_DIR}/${trustDomain}/root-key.pem 2048
openssl req -new -x509 -days 3650 -key ${DISTINCT_ROOTS_DIR}/${trustDomain}/root-key.pem \\
  -out ${DISTINCT_ROOTS_DIR}/${trustDomain}/root-cert.pem -subj "/CN=SPIRE Root CA - ${clusterName}"`
    )
    .join('\n\n');

  return `**Generate independent SPIRE roots** — before any cluster installs SPIRE, since \`distinctRoots\` is enabled on: ${targets.map(t => `\`${t.clusterName}\``).join(', ')}. Each of these clusters gets its own independent root CA, generated up front, so every cluster can trust its peers' roots as additional, unrelated trust anchors (not cross-signed).

\`\`\`bash
${genBlocks}
\`\`\``;
}

export async function generate(_subIndex, addonCfg, clusterName, _profile, _env) {
  const cfg = flatten(addonCfg);
  const ns = cfg.spireNamespace || 'spire-server';
  const trustDomain = resolveTrustDomain(cfg.trustDomain || clusterName, clusterName);
  const certMode = cfg.certMode || 'self-signed';
  const spireVersion = cfg.spireVersion || '0.30.0';
  const spireCrdsVersion = cfg.spireCrdsVersion || '0.6.0';
  const distinctRoots = cfg.distinctRoots === true;
  const multiRoot = cfg.multiRoot === true || distinctRoots;
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;
  const certsDir = `/tmp/spire-certs/${trustDomain}`;

  // The intermediate CA must carry basicConstraints=CA:true (openssl's default signing
  // extensions omit it, leaving a leaf-shaped cert that can't sign further certs - SPIRE
  // rejects it: "parent certificate cannot sign this kind of certificate"). subjectAltName
  // carries the trust domain on the intermediate itself, required by ztunnel's
  // VALIDATE_SPIFFE_TRUST_DOMAIN_NAMES=STRICT chain verification. Mirrors index.js exactly.
  const caExtFile = `${certsDir}/ca-ext.cnf`;
  const caExtFileBlock = `cat > ${caExtFile} <<'CNFEOF'
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no
[req_distinguished_name]
CN = SPIRE Intermediate CA
[v3_req]
keyUsage = critical, keyCertSign, cRLSign
basicConstraints = critical, CA:true, pathlen:1
subjectKeyIdentifier = hash
subjectAltName = DNS:${trustDomain}, URI:spiffe://${trustDomain}
CNFEOF`;

  // Both federation directions happen inline, right here, at first-mint time — not as a
  // later update to an already-running SPIRE server. istiod's cacerts secret already exists
  // (created in the Cluster Bootstrap lab, before any addon installs), and istiod itself
  // hasn't started yet, so: (1) SPIRE's very first published bundle already includes
  // istiod's root, and (2) patching cacerts now needs no istiod restart on a fresh install
  // (only if it's already running, e.g. a partial re-run). Mirrors installer.js exactly:
  // SPIRE's #prepareSelfSignedCerts folds istiod's root in before minting, then
  // #federateWithIstioCA patches cacerts — both inside spire's own deploy(), not deferred.
  // (Confirmed empirically that deferring this — patching bundle.crt on an already-running
  // SPIRE server — does NOT propagate: its BundlePublisher never republishes the update.)
  const federationBlock = `
cat ${certsDir}/istio-root.pem ${certsDir}/ca-chain.pem | base64 | tr -d '\\n' > ${certsDir}/merged-root-b64.txt
kubectl --context=${ctx} patch secret cacerts -n istio-system --type=merge \\
  -p "{\\"data\\":{\\"root-cert.pem\\":\\"$(cat ${certsDir}/merged-root-b64.txt)\\"}}"
kubectl --context=${ctx} get deployment istiod -n istio-system >/dev/null 2>&1 && \\
  kubectl --context=${ctx} rollout restart deployment/istiod -n istio-system || true`;

  let certSection;
  if (certMode === 'self-signed' && distinctRoots) {
    certSection = `
Build \`${trustDomain}\`'s intermediate CA from its pre-generated independent root (see **Generate independent SPIRE roots** above), and publish a bundle that trusts every peer's root directly (not cross-signed) plus istiod's own root:

\`\`\`bash
mkdir -p ${certsDir}

${caExtFileBlock}

openssl genrsa -out ${certsDir}/ca.key 2048
openssl req -new -key ${certsDir}/ca.key -out ${certsDir}/ca.csr -config ${caExtFile} -subj "/CN=SPIRE Intermediate CA"
openssl x509 -req -in ${certsDir}/ca.csr \\
  -CA ${DISTINCT_ROOTS_DIR}/${trustDomain}/root-cert.pem -CAkey ${DISTINCT_ROOTS_DIR}/${trustDomain}/root-key.pem \\
  -CAcreateserial -out ${certsDir}/ca.crt -days 1825 -extensions v3_req -extfile ${caExtFile}

kubectl --context=${ctx} get secret cacerts -n istio-system -o jsonpath='{.data.root-cert\\.pem}' | base64 -d > ${certsDir}/istio-root.pem

# SPIRE's own published bundle: own root, then istiod's, then every peer's (not cross-signed).
# Order matters here — mirrors index.js's #prepareSelfSignedCerts exactly (own root first,
# istiod root folded in next via multiRoot, peer roots appended last); building it any other
# order was confirmed live to silently break peer cert validation (UnknownIssuer).
cat ${DISTINCT_ROOTS_DIR}/${trustDomain}/root-cert.pem ${certsDir}/istio-root.pem > ${certsDir}/bundle.pem
for peer_root in ${DISTINCT_ROOTS_DIR}/*/root-cert.pem; do
  [ "$peer_root" = "${DISTINCT_ROOTS_DIR}/${trustDomain}/root-cert.pem" ] && continue
  cat "$peer_root" >> ${certsDir}/bundle.pem
done

# Full chain (intermediate + all roots)
cat ${certsDir}/ca.crt ${certsDir}/bundle.pem > ${certsDir}/ca-chain.pem

kubectl --context=${ctx} create namespace ${ns} --dry-run=client -o yaml | kubectl --context=${ctx} apply -f -
kubectl --context=${ctx} delete secret spiffe-upstream-ca -n ${ns} --ignore-not-found=true
kubectl --context=${ctx} create secret generic spiffe-upstream-ca -n ${ns} \\
  --from-file=tls.crt=${certsDir}/ca.crt \\
  --from-file=tls.key=${certsDir}/ca.key \\
  --from-file=bundle.crt=${certsDir}/bundle.pem

# Federate the other direction: merge SPIRE's chain into istiod's cacerts root too, so
# istiod-issued proxies (e.g. the east-west gateway) can verify a SPIRE-signed peer.
${federationBlock}
\`\`\``;
  } else if (certMode === 'self-signed' && multiRoot) {
    const sharedRootDir = '/tmp/spire-shared-root';
    certSection = `
Generate (or reuse) a SPIRE-only root, independent of Istio's own cacerts root, shared by every cluster, and publish a bundle that trusts it plus istiod's own root:

\`\`\`bash
mkdir -p ${sharedRootDir} ${certsDir}
if [ ! -f ${sharedRootDir}/root-key.pem ]; then
  openssl genrsa -out ${sharedRootDir}/root-key.pem 2048
  openssl req -new -x509 -days 3650 -key ${sharedRootDir}/root-key.pem \\
    -out ${sharedRootDir}/root-cert.pem -subj "/CN=SPIRE Root CA"
fi

${caExtFileBlock}

openssl genrsa -out ${certsDir}/ca.key 2048
openssl req -new -key ${certsDir}/ca.key -out ${certsDir}/ca.csr -config ${caExtFile} -subj "/CN=SPIRE Intermediate CA"
openssl x509 -req -in ${certsDir}/ca.csr \\
  -CA ${sharedRootDir}/root-cert.pem -CAkey ${sharedRootDir}/root-key.pem \\
  -CAcreateserial -out ${certsDir}/ca.crt -days 1825 -extensions v3_req -extfile ${caExtFile}

kubectl --context=${ctx} get secret cacerts -n istio-system -o jsonpath='{.data.root-cert\\.pem}' | base64 -d > ${certsDir}/istio-root.pem
cat ${sharedRootDir}/root-cert.pem ${certsDir}/istio-root.pem > ${certsDir}/bundle.pem
cat ${certsDir}/ca.crt ${certsDir}/bundle.pem > ${certsDir}/ca-chain.pem

kubectl --context=${ctx} create namespace ${ns} --dry-run=client -o yaml | kubectl --context=${ctx} apply -f -
kubectl --context=${ctx} delete secret spiffe-upstream-ca -n ${ns} --ignore-not-found=true
kubectl --context=${ctx} create secret generic spiffe-upstream-ca -n ${ns} \\
  --from-file=tls.crt=${certsDir}/ca.crt \\
  --from-file=tls.key=${certsDir}/ca.key \\
  --from-file=bundle.crt=${certsDir}/bundle.pem

# Federate the other direction: merge SPIRE's chain into istiod's cacerts root too, so
# istiod-issued proxies (e.g. the east-west gateway) can verify a SPIRE-signed peer.
${federationBlock}
\`\`\``;
  } else if (certMode === 'self-signed') {
    certSection = `
Generate SPIRE upstream CA certificates using openssl:

\`\`\`bash
mkdir -p ${certsDir}

# Generate root CA
openssl genrsa -out /tmp/spire-certs/root-key.pem 2048
openssl req -new -x509 -days 3650 -key /tmp/spire-certs/root-key.pem \\
  -out /tmp/spire-certs/root-cert.pem -subj "/CN=SPIRE Root CA"

${caExtFileBlock}

# Generate intermediate CA for this cluster
openssl genrsa -out ${certsDir}/ca.key 2048
openssl req -new -key ${certsDir}/ca.key \\
  -out ${certsDir}/ca.csr \\
  -config ${caExtFile} -subj "/CN=SPIRE Intermediate CA"
openssl x509 -req -in ${certsDir}/ca.csr \\
  -CA /tmp/spire-certs/root-cert.pem -CAkey /tmp/spire-certs/root-key.pem \\
  -CAcreateserial -out ${certsDir}/ca.crt -days 1825 -extensions v3_req -extfile ${caExtFile}

# Build cert chain
cat ${certsDir}/ca.crt /tmp/spire-certs/root-cert.pem \\
  > ${certsDir}/ca-chain.pem

# Create namespace and secret
kubectl --context=${ctx} create namespace ${ns} --dry-run=client -o yaml | kubectl --context=${ctx} apply -f -
kubectl --context=${ctx} delete secret spiffe-upstream-ca -n ${ns} --ignore-not-found=true
kubectl --context=${ctx} create secret generic spiffe-upstream-ca -n ${ns} \\
  --from-file=tls.crt=${certsDir}/ca.crt \\
  --from-file=tls.key=${certsDir}/ca.key \\
  --from-file=bundle.crt=${certsDir}/ca-chain.pem
\`\`\``;
  } else if (certMode === 'cert-manager') {
    certSection = `
Create the SPIRE upstream CA certificate using cert-manager:

\`\`\`bash
kubectl apply --context=${ctx} -f - <<EOF
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: spire-upstream-ca
  namespace: ${ns}
spec:
  secretName: spire-upstream-ca-cm
  isCA: true
  commonName: "SPIRE Intermediate CA - ${trustDomain}"
  issuerRef:
    name: selfsigned-issuer
    kind: ClusterIssuer
    group: cert-manager.io
  privateKey:
    algorithm: RSA
    size: 2048
EOF
\`\`\`

Wait for the secret to be created:

\`\`\`bash
kubectl --context=${ctx} wait --for=jsonpath='{.data.tls\\.crt}' secret/spire-upstream-ca-cm -n ${ns} --timeout=60s
\`\`\``;
  } else {
    certSection = `
Copy your pre-existing CA cert files and create the \`spiffe-upstream-ca\` secret:

\`\`\`bash
kubectl --context=${ctx} create namespace ${ns} --dry-run=client -o yaml | kubectl --context=${ctx} apply -f -
kubectl --context=${ctx} create secret generic spiffe-upstream-ca -n ${ns} \\
  --from-file=tls.crt=<path-to-ca.crt> \\
  --from-file=tls.key=<path-to-ca.key> \\
  --from-file=bundle.crt=<path-to-ca-chain.pem>
\`\`\``;
  }

  return `Install SPIRE for workload identity attestation in the ambient mesh on the **${clusterName}** cluster (trust domain \`${trustDomain}\`).
${certSection}

Add the SPIRE Helm repository and install the charts:

\`\`\`bash
helm repo add spire https://spiffe.github.io/helm-charts-hardened/
helm repo update spire

helm upgrade -i spire-crds spire/spire-crds \\
  --kube-context ${ctx} \\
  --namespace ${ns} \\
  --create-namespace \\
  --version ${spireCrdsVersion} \\
  --wait

helm upgrade -i spire spire/spire \\
  --kube-context ${ctx} \\
  --namespace ${ns} \\
  --version ${spireVersion} \\
  -f - <<EOF
global:
  spire:
    trustDomain: ${trustDomain}
spire-agent:
  authorizedDelegates:
    - "spiffe://${trustDomain}/ns/istio-system/sa/ztunnel"
  sockets:
    admin:
      enabled: true
      mountOnHost: true
    hostBasePath: /run/spire/agent/sockets
  tolerations:
    - effect: NoSchedule
      operator: Exists
    - key: CriticalAddonsOnly
      operator: Exists
    - effect: NoExecute
      operator: Exists
spire-server:
  upstreamAuthority:
    disk:
      enabled: true
      # secret.create is false - the spiffe-upstream-ca secret already exists (created above
      # with tls.crt/tls.key/bundle.crt). The chart only renders bundle_file_path (and thus
      # actually reads/uses the extra trust anchors in bundle.crt) when secret.data.bundle is
      # non-empty here, regardless of secret.create - this placeholder is required even though
      # the chart never uses it to create anything. Without it, SPIRE silently ignores
      # everything in bundle.crt beyond its own intermediate — confirmed live: the multi-cert
      # bundle looked correct on disk and in the K8s secret, but peer cert validation still
      # failed with "UnknownIssuer" until this placeholder was added.
      secret:
        create: false
        name: "spiffe-upstream-ca"
        data:
          bundle: "externally-managed"
spiffe-csi-driver:
  tolerations:
    - effect: NoSchedule
      operator: Exists
    - key: CriticalAddonsOnly
      operator: Exists
    - effect: NoExecute
      operator: Exists
EOF
\`\`\`

Verify SPIRE pods are ready:

\`\`\`bash
kubectl --context=${ctx} -n ${ns} wait --for=condition=Ready pods --all --timeout=300s
\`\`\`

Register ClusterSPIFFEID resources so SPIRE issues identities to ambient workloads:

\`\`\`bash
kubectl apply --context=${ctx} -f - <<EOF
---
apiVersion: spire.spiffe.io/v1alpha1
kind: ClusterSPIFFEID
metadata:
  name: istio-ztunnel-reg
spec:
  spiffeIDTemplate: "spiffe://{{ .TrustDomain }}/ns/{{ .PodMeta.Namespace }}/sa/{{ .PodSpec.ServiceAccountName }}"
  podSelector:
    matchLabels:
      app: "ztunnel"
---
apiVersion: spire.spiffe.io/v1alpha1
kind: ClusterSPIFFEID
metadata:
  name: istio-waypoint-reg
spec:
  spiffeIDTemplate: "spiffe://{{ .TrustDomain }}/ns/{{ .PodMeta.Namespace }}/sa/{{ .PodSpec.ServiceAccountName }}"
  podSelector:
    matchLabels:
      istio.io/gateway-name: waypoint
---
apiVersion: spire.spiffe.io/v1alpha1
kind: ClusterSPIFFEID
metadata:
  name: istio-agentgateway-waypoint-reg
spec:
  spiffeIDTemplate: "spiffe://{{ .TrustDomain }}/ns/{{ .PodMeta.Namespace }}/sa/{{ .PodSpec.ServiceAccountName }}"
  podSelector:
    matchLabels:
      waypoint: "true"
---
apiVersion: spire.spiffe.io/v1alpha1
kind: ClusterSPIFFEID
metadata:
  name: istio-ambient-reg
spec:
  spiffeIDTemplate: "spiffe://{{ .TrustDomain }}/ns/{{ .PodMeta.Namespace }}/sa/{{ .PodSpec.ServiceAccountName }}"
  podSelector:
    matchLabels:
      istio.io/dataplane-mode: ambient
EOF
\`\`\``;
}

export function cleanup(addonCfg, clusterName) {
  const cfg = flatten(addonCfg);
  const ns = cfg.spireNamespace || 'spire-server';
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;
  return `\`\`\`bash
kubectl --context=${ctx} delete clusterspiffeid istio-ambient-reg istio-waypoint-reg istio-agentgateway-waypoint-reg istio-ztunnel-reg --ignore-not-found=true
helm uninstall spire -n ${ns} --kube-context ${ctx} --no-hooks || true
helm uninstall spire-crds -n ${ns} --kube-context ${ctx} --no-hooks || true
# spiffe-oidc-discovery-provider (finishes as Completed) routinely gets stuck terminating and
# blocks namespace finalization indefinitely - force-delete before deleting the namespace.
kubectl --context=${ctx} delete pods --all -n ${ns} --force --grace-period=0 --ignore-not-found=true
kubectl --context=${ctx} delete namespace ${ns} --ignore-not-found=true
\`\`\``;
}
