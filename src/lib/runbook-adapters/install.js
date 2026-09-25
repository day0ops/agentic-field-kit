// src/lib/runbook-adapters/install.js
import { dump as yamlDump } from 'js-yaml';
import { resolveRunbookTemplates } from './template-vars.js';

// Mirrors installer.js constants
const CHART_MAP = {
  base: 'base',
  istiod: 'istiod',
  cni: 'cni',
  ztunnel: 'ztunnel',
  'peering-eastwest': 'peering',
};

const RELEASE_NAME_MAP = {
  base: 'istio-base',
  istiod: 'istiod',
  cni: 'istio-cni',
  ztunnel: 'ztunnel',
  'peering-eastwest': 'peering-eastwest',
};

const NAMESPACE_MAP = {
  'peering-eastwest': 'istio-eastwest',
};

// Installed in a deferred post phase — not per-cluster during main loop
const DEFERRED = new Set(['peering-remote']);

function deepMerge(target, source) {
  if (!source) return { ...target };
  if (!target) return { ...source };
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const s = source[key];
    const t = result[key];
    if (Array.isArray(s)) {
      result[key] = [...s];
    } else if (s && typeof s === 'object' && !Array.isArray(s)) {
      result[key] = deepMerge(t && typeof t === 'object' ? t : {}, s);
    } else {
      result[key] = s;
    }
  }
  return result;
}

function buildBaseValues(componentName, { istioRepo, istioTag, meshProfile, ns }) {
  switch (componentName) {
    case 'base':
      return { defaultRevision: 'stable', profile: meshProfile };
    case 'istiod':
      return {
        global: { hub: istioRepo, tag: istioTag, proxy: { clusterDomain: 'cluster.local' } },
        profile: meshProfile,
      };
    case 'cni':
      return {
        ambient: { dnsCapture: true },
        excludeNamespaces: [ns, 'kube-system'],
        global: { hub: istioRepo, tag: istioTag },
        profile: meshProfile,
      };
    case 'ztunnel':
      return {
        hub: istioRepo,
        tag: istioTag,
        profile: meshProfile,
        istioNamespace: ns,
        namespace: ns,
        enabled: true,
        configValidation: true,
        env: { L7_ENABLED: 'true' },
        proxy: { clusterDomain: 'cluster.local' },
        terminationGracePeriodSeconds: 29,
        variant: 'distroless',
      };
    case 'peering-eastwest':
      return { eastwest: { create: true, deployment: {} } };
    default:
      return {};
  }
}

export class InstallAdapter {
  envVars(_selection) {
    return [];
  }
  envExports(selection) {
    const mesh = selection?.profile?.spec?.mesh || {};
    const istioVersion = mesh.istioVersion || '';
    const istioTag = mesh.image?.tag || (istioVersion ? `${istioVersion}-solo` : '');
    if (!istioTag) return [];
    return [
      { name: 'ISTIO_VERSION', value: istioTag, comment: 'Istio Ambient Helm chart version' },
    ];
  }

  // Cert/trust material must exist before ANY cluster installs anything (addons included) —
  // mirrors installer.js's real order: CertificateManager + SpireRootManager run once, globally,
  // before the per-cluster addon/istio install loop even starts. This is what lets SPIRE's addon
  // (a pre-phase addon, installed before istiod) fold istiod's cacerts root into its own bundle
  // at first-mint time instead of needing to federate an already-published bundle after the fact
  // (confirmed empirically: SPIRE's BundlePublisher does not republish a later bundle.crt update).
  generateCertSetup(labNum, selection, extraSections = []) {
    const { profile, infraProfile } = selection;
    const mesh = profile.spec?.mesh || {};
    const clusters = infraProfile.spec?.clusters || [];
    const isMultiCluster = clusters.length > 1;
    const certMode = mesh.certificates?.mode || 'self-signed';

    const sections = [];
    if (isMultiCluster) {
      sections.push(this._certSection(certMode, clusters, 'istio-system'));
    }
    sections.push(...extraSections);

    if (sections.length === 0) return '';

    return `## Lab ${labNum} — Cluster Bootstrap

Set up shared trust material before installing any addon or mesh component.

${sections.join('\n\n')}`;
  }

  generate(labNum, selection) {
    const { profile, infraProfile, environment } = selection;
    const mesh = profile.spec?.mesh || {};
    const clusters = infraProfile.spec?.clusters || [];
    const isMultiCluster = clusters.length > 1;

    const ns = 'istio-system';
    const istioRepo = mesh.image?.istioRepo || 'us-docker.pkg.dev/soloio-img/istio';
    const helmIstioRepo = mesh.image?.helmIstioRepo || 'us-docker.pkg.dev/soloio-img/istio-helm';
    const istioVersion = mesh.istioVersion || '';
    const istioTag = mesh.image?.tag || (istioVersion ? `${istioVersion}-solo` : '');
    const gatewayApiVersion = mesh.gatewayApiVersion || 'v1.4.0';
    const meshProfile = mesh.profile || 'ambient';
    const peeringMethod = mesh.peering || 'helm';

    const cfg = { istioRepo, helmIstioRepo, istioTag, meshProfile, ns, environment };

    // Normalise components list from profile
    const rawComponents = (mesh.components || []).map(c =>
      typeof c === 'string' ? { name: c, values: {} } : { name: c.name, values: c.values || {} }
    );

    const sections = [];

    // ── Gateway API CRDs ────────────────────────────────────────────────────
    // CRDs are cluster-scoped — must be applied on every cluster, not just whichever
    // one happens to be the operator's current kubectl context.
    const gatewayApiCrdLines = clusters
      .map(
        c =>
          `kubectl --context=$${c.name.toUpperCase()}_CONTEXT apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/${gatewayApiVersion}/standard-install.yaml`
      )
      .join('\n');
    sections.push(`### Install Gateway API CRDs

\`\`\`bash
${gatewayApiCrdLines}
\`\`\``);

    // ── Per-cluster install ──────────────────────────────────────────────────
    for (const cluster of clusters) {
      sections.push(this._clusterSection(cluster, rawComponents, cfg, isMultiCluster));
    }

    // ── Multicluster linking ─────────────────────────────────────────────────
    if (isMultiCluster) {
      sections.push(this._multiclusterSection(clusters, rawComponents, cfg, peeringMethod));
    }

    return `## Lab ${labNum} — Install Istio Ambient

Install Solo Istio ${istioVersion}${istioVersion ? ' ' : ''}in ambient mode on all clusters using Helm.

${sections.join('\n\n')}`;
  }

  // ── Certificate setup ──────────────────────────────────────────────────────

  _certSection(certMode, clusters, ns) {
    if (certMode === 'self-signed') {
      const clusterBlocks = clusters
        .map(c => {
          const ctx = `$${c.name.toUpperCase()}_CONTEXT`;
          return `# ${c.name}
kubectl --context=${ctx} create namespace ${ns} --dry-run=client -o yaml | kubectl --context=${ctx} apply -f -
kubectl --context=${ctx} delete secret cacerts -n ${ns} --ignore-not-found=true
kubectl --context=${ctx} create secret generic cacerts -n ${ns} \\
  --from-file=certs/${c.name}/ca-cert.pem \\
  --from-file=certs/${c.name}/ca-key.pem \\
  --from-file=certs/${c.name}/root-cert.pem \\
  --from-file=certs/${c.name}/cert-chain.pem`;
        })
        .join('\n\n');

      const clusterCertGen = clusters
        .map(
          c => `
# Intermediate CA — ${c.name}
mkdir -p certs/${c.name}
cat > certs/${c.name}/ca-ext.cnf <<'EOF'
basicConstraints=CA:true,pathlen:0
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EOF
openssl genrsa -out certs/${c.name}/ca-key.pem 4096
openssl req -new -sha256 -key certs/${c.name}/ca-key.pem \\
  -out certs/${c.name}/ca-csr.pem \\
  -subj "/O=Istio/CN=Intermediate CA - ${c.name}"
openssl x509 -req -days 3650 -sha256 \\
  -CA certs/root-cert.pem -CAkey certs/root-key.pem -CAcreateserial \\
  -in certs/${c.name}/ca-csr.pem -out certs/${c.name}/ca-cert.pem \\
  -extfile certs/${c.name}/ca-ext.cnf
cat certs/${c.name}/ca-cert.pem certs/root-cert.pem > certs/${c.name}/cert-chain.pem
cp certs/root-cert.pem certs/${c.name}/root-cert.pem`
        )
        .join('\n');

      return `### Set Up Shared Root of Trust

Generate a shared root CA and per-cluster intermediate CAs. The \`cacerts\` secret must exist in \`${ns}\` before istiod starts.

\`\`\`bash
mkdir -p certs

# Shared root CA
openssl genrsa -out certs/root-key.pem 4096
openssl req -new -x509 -days 3650 -key certs/root-key.pem -sha256 \\
  -out certs/root-cert.pem -subj "/O=Istio/CN=Root CA"
${clusterCertGen}
\`\`\`

Apply \`cacerts\` secret to each cluster before installing istiod:

\`\`\`bash
${clusterBlocks}
\`\`\``;
    }

    // cert-manager mode
    const clusterBlocks = clusters
      .map(c => {
        const ctx = `$${c.name.toUpperCase()}_CONTEXT`;
        return `# ${c.name}
kubectl --context=${ctx} create namespace ${ns} --dry-run=client -o yaml | kubectl --context=${ctx} apply -f -
kubectl --context=${ctx} create secret tls istio-root-ca-secret -n ${ns} \\
  --cert=/tmp/agentic-root-ca-cert.pem --key=/tmp/agentic-root-ca-key.pem
kubectl --context=${ctx} apply -f - <<EOF
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: istio-root-ca
  namespace: ${ns}
spec:
  ca:
    secretName: istio-root-ca-secret
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: istio-cacerts
  namespace: ${ns}
spec:
  secretName: cacerts
  duration: 87600h
  renewBefore: 720h
  isCA: true
  commonName: "Intermediate CA - ${c.name}"
  subject:
    organizations: [Istio]
    localities: [${c.name}]
  issuerRef:
    name: istio-root-ca
    kind: Issuer
    group: cert-manager.io
  secretTemplate:
    labels:
      istio.io/key-and-cert: "true"
  privateKey:
    algorithm: RSA
    size: 4096
EOF
kubectl --context=${ctx} wait secret/cacerts -n ${ns} --for=jsonpath='{.data}' --timeout=120s`;
      })
      .join('\n\n');

    return `### Set Up Shared Root of Trust (cert-manager)

\`\`\`bash
# Shared root CA key pair (local only — key deleted after distribution)
openssl genrsa -out /tmp/agentic-root-ca-key.pem 4096
openssl req -new -x509 -key /tmp/agentic-root-ca-key.pem \\
  -out /tmp/agentic-root-ca-cert.pem -days 3650 -subj "/O=Istio/CN=Root CA"
\`\`\`

Create cert-manager resources on each cluster:

\`\`\`bash
${clusterBlocks}
\`\`\`

\`\`\`bash
rm /tmp/agentic-root-ca-key.pem /tmp/agentic-root-ca-cert.pem
\`\`\``;
  }

  // ── Per-cluster installation ───────────────────────────────────────────────

  _clusterSection(cluster, rawComponents, cfg, _isMultiCluster) {
    const { helmIstioRepo, ns, environment } = cfg;
    const ctx = `$${cluster.name.toUpperCase()}_CONTEXT`;
    const installable = rawComponents.filter(c => !DEFERRED.has(c.name) && CHART_MAP[c.name]);

    const helmBlocks = installable.map(comp => {
      const chart = CHART_MAP[comp.name];
      const release = RELEASE_NAME_MAP[comp.name];
      const compNs = NAMESPACE_MAP[comp.name] || ns;

      const baseVals = buildBaseValues(comp.name, cfg);
      const profileVals = resolveRunbookTemplates(comp.values, {
        env: environment,
        clusterName: cluster.name,
      });
      const mergedVals = deepMerge(baseVals, profileVals);
      const valuesYaml = yamlDump(mergedVals, {
        lineWidth: 120,
        quotingType: '"',
        forceQuotes: false,
      })
        .trimEnd()
        .split('\n')
        .map(l => `  ${l}`)
        .join('\n');

      // License is a secret — pass it as a --set-string flag (always shell-expanded) rather
      // than embedding it in the piped values file (wrapped in a quoted heredoc, so a $VAR
      // reference there would never expand).
      const licenseFlag =
        comp.name === 'istiod' ? '  --set-string license.value=$ENTERPRISE_ISTIO_LICENSE \\\n' : '';

      return `# ${comp.name}
helm upgrade --install ${release} oci://${helmIstioRepo}/${chart} \\
  --kube-context=${ctx} \\
  --namespace ${compNs} \\
  --create-namespace \\
  --version $ISTIO_VERSION \\
${licenseFlag}  --wait \\
  --timeout 10m \\
  -f - <<'EOF'
${valuesYaml}
EOF`;
    });

    const networkLabel = `kubectl --context=${ctx} label namespace ${ns} \\
  topology.istio.io/network=${cluster.name} --overwrite`;

    return `### Install on \`${cluster.name}\`

\`\`\`bash
kubectl --context=${ctx} create namespace ${ns} --dry-run=client -o yaml | kubectl --context=${ctx} apply -f -
\`\`\`

\`\`\`bash
${helmBlocks.join('\n\n')}
\`\`\`

Label namespace with network topology:

\`\`\`bash
${networkLabel}
\`\`\``;
  }

  // ── Multicluster linking ───────────────────────────────────────────────────

  _multiclusterSection(clusters, rawComponents, cfg, peeringMethod) {
    const { helmIstioRepo } = cfg;
    const peeringRemote = rawComponents.find(c => c.name === 'peering-remote');

    const sections = [];

    if (peeringMethod === 'helm' && peeringRemote) {
      // peering-remote needs each peer's *real* east-west gateway address (not a template) to
      // connect to it — mirrors ClusterLinker#discoverAllPeerInfo/#linkViaHelm. Without this,
      // peering-remote has no way to reach its peer: clusters install successfully but never
      // federate (no cross-cluster mesh.internal DNS, no global service discovery).
      const rawVals = peeringRemote.values || {};
      const trustDomainPattern = rawVals.trustDomain || 'cluster.local';
      const addressType = rawVals.addressType || 'Hostname';
      const serviceType = (rawVals.preferredDataplaneServiceType || 'LoadBalancer').toLowerCase();

      const addressVar = name => `${name.toUpperCase()}_EW_ADDRESS`;
      const discoverLines = clusters
        .map(cluster => {
          const ctx = `$${cluster.name.toUpperCase()}_CONTEXT`;
          return `export ${addressVar(cluster.name)}=$(kubectl --context=${ctx} get svc istio-eastwest -n istio-eastwest -o jsonpath="{.status.loadBalancer.ingress[0]['hostname','ip']}")`;
        })
        .join('\n');

      const helmBlocks = clusters
        .map(cluster => {
          const ctx = `$${cluster.name.toUpperCase()}_CONTEXT`;
          const peers = clusters.filter(c => c.name !== cluster.name);
          const items = peers.map(peer => ({
            name: `istio-remote-peer-${peer.name}`,
            cluster: peer.name,
            network: peer.name,
            addressType,
            // Trust domain identifies the PEER cluster being connected to, not this one.
            address: `$${addressVar(peer.name)}`,
            preferredDataplaneServiceType: serviceType,
            trustDomain: trustDomainPattern.replace(/\{\{\s*cluster\.name\s*\}\}/g, peer.name),
          }));
          const valuesYaml = yamlDump({ remote: { create: true, items } }, { lineWidth: 120 })
            .trimEnd()
            .split('\n')
            .map(l => `  ${l}`)
            .join('\n');

          return `# peering-remote on ${cluster.name}
helm upgrade --install peering-remote oci://${helmIstioRepo}/peering \\
  --kube-context=${ctx} \\
  --namespace istio-eastwest \\
  --create-namespace \\
  --version $ISTIO_VERSION \\
  --wait \\
  -f - <<EOF
${valuesYaml}
EOF`;
        })
        .join('\n\n');

      sections.push(`### Link Clusters (Helm Peering)

Discover each cluster's east-west gateway address — \`peering-remote\` needs a peer's real address to connect to it:

\`\`\`bash
${discoverLines}
\`\`\`

\`\`\`bash
${helmBlocks}
\`\`\``);
    } else {
      // East-west gateway (istioctl method)
      const gwBlocks = clusters
        .map(c => {
          const ctx = `$${c.name.toUpperCase()}_CONTEXT`;
          return `# ${c.name}
kubectl --context=${ctx} create namespace istio-eastwest --dry-run=client -o yaml | kubectl --context=${ctx} apply -f -
istioctl --context=${ctx} install -y -f - <<'EOF'
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
spec:
  profile: empty
  components:
    ingressGateways:
      - name: istio-eastwest
        label:
          istio: eastwestgateway
          app: istio-eastwestgateway
          topology.istio.io/network: ${c.name}
        enabled: true
        k8s:
          env:
            - name: ISTIO_META_ROUTER_MODE
              value: sni-dnat
            - name: ISTIO_META_REQUESTED_NETWORK_VIEW
              value: ${c.name}
          service:
            ports:
              - name: status-port
                port: 15021
                targetPort: 15021
              - name: tls
                port: 15443
                targetPort: 15443
              - name: tls-istiod
                port: 15012
                targetPort: 15012
              - name: tls-webhook
                port: 15017
                targetPort: 15017
EOF`;
        })
        .join('\n\n');

      sections.push(`### Deploy East-West Gateways

\`\`\`bash
${gwBlocks}
\`\`\``);

      sections.push(`### Exchange Service Accounts and Link Clusters

\`\`\`bash
${clusters
  .flatMap(src =>
    clusters
      .filter(dst => dst.name !== src.name)
      .map(
        dst =>
          `istioctl x create-remote-secret --context=$${src.name.toUpperCase()}_CONTEXT \\
  --name=${src.name} | kubectl --context=$${dst.name.toUpperCase()}_CONTEXT apply -f -`
      )
  )
  .join('\n')}
\`\`\``);
    }

    return sections.join('\n\n');
  }

  cleanup(_selection) {
    return '';
  }

  generateCleanupSections(labNum, selection, startIndex) {
    const { profile, infraProfile } = selection;
    const mesh = profile.spec?.mesh || {};
    const clusters = infraProfile.spec?.clusters || [];
    if (clusters.length === 0) return [];

    const isMultiCluster = clusters.length > 1;
    const peeringMethod = mesh.peering || 'helm';
    const rawComponents = (mesh.components || []).map(c =>
      typeof c === 'string' ? { name: c } : { name: c.name }
    );
    const installable = rawComponents.filter(c => !DEFERRED.has(c.name) && CHART_MAP[c.name]);
    const usesEastwestNamespace = isMultiCluster || installable.some(c => NAMESPACE_MAP[c.name]);

    const lines = [];

    if (isMultiCluster) {
      lines.push('Unlink clusters first:');
      lines.push('');
      lines.push('```bash');
      if (peeringMethod === 'helm') {
        for (const cluster of clusters) {
          const ctx = `$${cluster.name.toUpperCase()}_CONTEXT`;
          lines.push(`helm uninstall peering-remote --kube-context=${ctx} -n istio-eastwest`);
        }
      } else {
        for (const cluster of clusters) {
          const ctx = `--context=$${cluster.name.toUpperCase()}_CONTEXT`;
          lines.push(`kubectl ${ctx} delete namespace istio-eastwest --ignore-not-found=true`);
        }
      }
      lines.push('```');
      lines.push('');
    }

    lines.push('Uninstall Istio components on each cluster (reverse of install order):');
    lines.push('');
    for (const cluster of clusters) {
      const ctx = `$${cluster.name.toUpperCase()}_CONTEXT`;
      lines.push(`**Uninstall on \`${cluster.name}\`**`);
      lines.push('');
      lines.push('```bash');
      for (const comp of [...installable].reverse()) {
        const release = RELEASE_NAME_MAP[comp.name];
        const compNs = NAMESPACE_MAP[comp.name] || 'istio-system';
        lines.push(`helm uninstall ${release} --kube-context=${ctx} -n ${compNs}`);
      }
      lines.push(`kubectl --context=${ctx} delete namespace istio-system --ignore-not-found=true`);
      if (usesEastwestNamespace) {
        lines.push(
          `kubectl --context=${ctx} delete namespace istio-eastwest --ignore-not-found=true`
        );
      }
      lines.push('```');
      lines.push('');
    }

    const heading = `### Lab ${labNum}.${startIndex} — Uninstall Istio Ambient`;
    return [`${heading}\n\n${lines.join('\n').trimEnd()}`];
  }
}
