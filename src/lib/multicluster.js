/**
 * Multicluster Infrastructure
 *
 * Core classes for multicluster Istio ambient mesh setup.
 * Called directly by installer.js — not part of the user-facing feature registry.
 *
 *   CertificateManager — shared root CA + per-cluster intermediate CAs
 *   EastWestGateway    — east-west gateway deployment per cluster
 *   ClusterLinker      — cluster linking (helm peering-remote or declarative)
 */

import { CommandRunner, Logger, BoxedOutput } from './common.js';
import { IstioctlHelper } from './istioctl.js';
import { buildRemotePeerGateway } from './resources/index.js';
import yaml from 'js-yaml';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from 'fs';

// ── CertificateManager ────────────────────────────────────────────────────────

// Exported so the spire addon can sign its intermediate off this same shared root
// (see addons/spire/index.js) instead of generating an independent, mutually
// untrusted root.
export const CERTS_WORK_DIR = join(tmpdir(), 'agentic-certs');

/**
 * Generates a shared root of trust and per-cluster intermediate CA certificates
 * for multicluster Istio ambient mesh.
 *
 * Configuration:
 * {
 *   mode: 'self-signed' | 'cert-manager',  // default: 'self-signed'
 *   clusters: [{ name, context }],
 *   certManager: { issuerName: string },    // cert-manager mode only
 * }
 */
export class CertificateManager {
  constructor(config) {
    this.config = config;
  }

  async deploy() {
    const mode = this.config.mode || 'self-signed';
    const clusters = this.config.clusters;

    Logger.info(`Setting up certificates (mode: ${mode}) for ${clusters.length} cluster(s)`);

    if (mode === 'self-signed') {
      await this.#deploySelfSigned(clusters);
    } else {
      await this.#deployCertManager(clusters);
    }
  }

  async cleanup() {
    const mode = this.config.mode || 'self-signed';
    const clusters = this.config.clusters;

    Logger.info('Cleaning up certificates...');

    for (const cluster of clusters) {
      const contextFlag = cluster.context ? `--context=${cluster.context}` : '';
      try {
        await CommandRunner.exec(
          `kubectl ${contextFlag} delete secret cacerts -n istio-system --ignore-not-found=true`
        );
        Logger.info(`Removed cacerts secret from ${cluster.name}`);
      } catch {
        Logger.warn(`Could not remove cacerts from ${cluster.name}`);
      }
    }

    if (mode === 'cert-manager') {
      for (const cluster of clusters) {
        const contextFlag = cluster.context ? `--context=${cluster.context}` : '';
        try {
          await CommandRunner.exec(
            `kubectl ${contextFlag} delete certificate istio-cacerts -n istio-system --ignore-not-found=true`
          );
          await CommandRunner.exec(
            `kubectl ${contextFlag} delete issuer istio-intermediate-ca -n istio-system --ignore-not-found=true`
          );
          await CommandRunner.exec(
            `kubectl ${contextFlag} delete certificate istio-root-ca -n istio-system --ignore-not-found=true`
          );
          await CommandRunner.exec(
            `kubectl ${contextFlag} delete clusterissuer istio-root-ca --ignore-not-found=true`
          );
        } catch {
          Logger.warn(`Could not fully clean cert-manager resources from ${cluster.name}`);
        }
      }
    }

    Logger.success('Certificates cleaned up');
  }

  /**
   * Generate a shared root CA + per-cluster intermediate CAs using openssl.
   *
   * cacerts secret format expected by istiod:
   *   ca-cert.pem    — intermediate cert
   *   ca-key.pem     — intermediate private key
   *   root-cert.pem  — shared root cert
   *   cert-chain.pem — intermediate + root (concatenated)
   */
  async #deploySelfSigned(clusters) {
    mkdirSync(CERTS_WORK_DIR, { recursive: true });

    const rootKeyPath = join(CERTS_WORK_DIR, 'root-key.pem');
    const rootCertPath = join(CERTS_WORK_DIR, 'root-cert.pem');

    if (!existsSync(rootKeyPath)) {
      Logger.info('Generating shared root CA...');
      await CommandRunner.exec(`openssl genrsa -out "${rootKeyPath}" 4096`);
      await CommandRunner.exec(
        `openssl req -new -x509 -days 3650 -key "${rootKeyPath}" -sha256 ` +
          `-out "${rootCertPath}" -subj "/O=Istio/CN=Root CA"`
      );
    } else {
      Logger.info('Root CA already exists, reusing');
    }

    for (const cluster of clusters) {
      const clusterDir = join(CERTS_WORK_DIR, cluster.name);
      mkdirSync(clusterDir, { recursive: true });

      const caKeyPath = join(clusterDir, 'ca-key.pem');
      const caCsrPath = join(clusterDir, 'ca-csr.pem');
      const caCertPath = join(clusterDir, 'ca-cert.pem');
      const certChainPath = join(clusterDir, 'cert-chain.pem');
      const clusterRootPath = join(clusterDir, 'root-cert.pem');
      const extFile = join(clusterDir, 'ca-ext.cnf');

      Logger.info(`Generating intermediate CA for ${cluster.name}...`);

      writeFileSync(
        extFile,
        'basicConstraints=CA:true,pathlen:0\n' +
          'subjectKeyIdentifier=hash\n' +
          'authorityKeyIdentifier=keyid,issuer\n'
      );

      await CommandRunner.exec(`openssl genrsa -out "${caKeyPath}" 4096`);
      await CommandRunner.exec(
        `openssl req -new -sha256 -key "${caKeyPath}" -out "${caCsrPath}" ` +
          `-subj "/O=Istio/CN=Intermediate CA - ${cluster.name}"`
      );
      await CommandRunner.exec(
        `openssl x509 -req -days 3650 -sha256 ` +
          `-CA "${rootCertPath}" -CAkey "${rootKeyPath}" -CAcreateserial ` +
          `-in "${caCsrPath}" -out "${caCertPath}" -extfile "${extFile}"`
      );

      writeFileSync(
        certChainPath,
        readFileSync(caCertPath, 'utf8') + readFileSync(rootCertPath, 'utf8')
      );
      writeFileSync(clusterRootPath, readFileSync(rootCertPath, 'utf8'));

      const contextFlag = cluster.context ? `--context=${cluster.context}` : '';

      await CommandRunner.exec(
        `kubectl ${contextFlag} create namespace istio-system --dry-run=client -o yaml | kubectl ${contextFlag} apply -f -`
      );
      await CommandRunner.exec(
        `kubectl ${contextFlag} delete secret cacerts -n istio-system --ignore-not-found=true`
      );
      await CommandRunner.exec(
        `kubectl ${contextFlag} create secret generic cacerts -n istio-system ` +
          `--from-file="${caCertPath}" ` +
          `--from-file="${caKeyPath}" ` +
          `--from-file="${clusterRootPath}" ` +
          `--from-file="${certChainPath}"`
      );

      Logger.success(`cacerts secret installed on ${cluster.name}`);

      const restartResult = await CommandRunner.exec(
        `kubectl ${contextFlag} rollout restart deployment/istiod -n istio-system`,
        { ignoreError: true }
      );
      if (!restartResult.exitCode) {
        Logger.info(`istiod restarted on ${cluster.name} to load new cacerts`);
        await CommandRunner.exec(
          `kubectl ${contextFlag} rollout status deployment/istiod -n istio-system --timeout=120s`,
          { ignoreError: true }
        );
      }
    }

    Logger.success('Shared root CA and intermediate CAs deployed to all clusters');
  }

  async #deployCertManager(clusters) {
    const issuerName = this.config.certManager?.issuerName || 'istio-root-ca';

    Logger.info('Generating shared root CA key pair...');

    await CommandRunner.exec('openssl genrsa -out /tmp/agentic-root-ca-key.pem 4096', {
      ignoreError: false,
    });
    await CommandRunner.exec(
      'openssl req -new -x509 -key /tmp/agentic-root-ca-key.pem ' +
        '-out /tmp/agentic-root-ca-cert.pem -days 3650 ' +
        '-subj "/O=Istio/CN=Root CA"',
      { ignoreError: false }
    );

    for (const cluster of clusters) {
      const contextFlag = cluster.context ? `--context=${cluster.context}` : '';

      await CommandRunner.exec(
        `kubectl ${contextFlag} create namespace istio-system --dry-run=client -o yaml | kubectl ${contextFlag} apply -f -`
      );

      Logger.info(`Distributing root CA to ${cluster.name}...`);
      await CommandRunner.exec(
        `kubectl ${contextFlag} delete secret istio-root-ca-secret -n istio-system --ignore-not-found=true`
      );
      await CommandRunner.exec(
        `kubectl ${contextFlag} create secret tls istio-root-ca-secret -n istio-system ` +
          `--cert=/tmp/agentic-root-ca-cert.pem --key=/tmp/agentic-root-ca-key.pem`
      );

      Logger.info(`Creating cert-manager resources on ${cluster.name}...`);

      const caIssuer = {
        apiVersion: 'cert-manager.io/v1',
        kind: 'Issuer',
        metadata: { name: issuerName, namespace: 'istio-system' },
        spec: { ca: { secretName: 'istio-root-ca-secret' } },
      };

      const intermediateCert = {
        apiVersion: 'cert-manager.io/v1',
        kind: 'Certificate',
        metadata: { name: 'istio-cacerts', namespace: 'istio-system' },
        spec: {
          secretName: 'cacerts',
          duration: '87600h',
          renewBefore: '720h',
          isCA: true,
          commonName: `Intermediate CA - ${cluster.name}`,
          subject: {
            organizations: ['Istio'],
            localities: [cluster.name],
          },
          issuerRef: { name: issuerName, kind: 'Issuer', group: 'cert-manager.io' },
          secretTemplate: { labels: { 'istio.io/key-and-cert': 'true' } },
          privateKey: { algorithm: 'RSA', size: 4096 },
        },
      };

      await this.#applyYamlResource(caIssuer, contextFlag);
      await this.#applyYamlResource(intermediateCert, contextFlag);

      Logger.info(`Waiting for cacerts secret on ${cluster.name}...`);
      await this.#waitForSecret('cacerts', 'istio-system', contextFlag);

      Logger.success(`cert-manager certificates ready on ${cluster.name}`);
    }

    try {
      unlinkSync('/tmp/agentic-root-ca-key.pem');
      unlinkSync('/tmp/agentic-root-ca-cert.pem');
    } catch {
      /* best effort */
    }

    Logger.success('cert-manager certificates generated and deployed');
  }

  async #applyYamlResource(resource, contextFlag) {
    const yamlContent = yaml.dump(resource, { lineWidth: -1 });
    const tempFile = join(tmpdir(), `.agentic-cert-${Date.now()}.yaml`);
    writeFileSync(tempFile, yamlContent);
    try {
      await CommandRunner.exec(`kubectl ${contextFlag} apply -f ${tempFile}`);
    } finally {
      try {
        unlinkSync(tempFile);
      } catch {
        /* best effort */
      }
    }
  }

  async #waitForSecret(name, namespace, contextFlag, timeoutMs = 120000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = await CommandRunner.exec(
        `kubectl ${contextFlag} get secret ${name} -n ${namespace}`,
        { ignoreError: true }
      );
      if (!result.exitCode) return;
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    throw new Error(`Secret ${name} not found in ${namespace} within timeout`);
  }
}

// ── SpireRootManager ──────────────────────────────────────────────────────────

// Exported so the spire addon can discover every peer cluster's pre-generated root
// (see addons/spire/index.js, distinctRoots mode) once this manager has run.
export const SPIRE_DISTINCT_ROOTS_DIR = join(tmpdir(), 'agentic-spire-distinct-roots');

/**
 * Pre-generates one independent, mutually-unrelated root CA per cluster, before any
 * cluster installs, for SPIRE's distinctRoots mode. Trust between clusters comes from
 * each cluster's SPIRE bundle listing every peer's root as an additional trust anchor,
 * not from cross-signing - so all this does is make every root available on disk up
 * front, before cluster install order could otherwise hide a peer's root from view.
 *
 * Configuration:
 * {
 *   clusters: [{ name, trustDomain }],
 * }
 */
export class SpireRootManager {
  constructor(config) {
    this.config = config;
  }

  async deploy() {
    const clusters = this.config.clusters;
    Logger.info(`Generating ${clusters.length} independent SPIRE root(s)...`);
    mkdirSync(SPIRE_DISTINCT_ROOTS_DIR, { recursive: true });

    for (const cluster of clusters) {
      const dir = join(SPIRE_DISTINCT_ROOTS_DIR, cluster.trustDomain.replace(/\//g, '-'));
      mkdirSync(dir, { recursive: true });
      const keyPath = join(dir, 'root-key.pem');
      const certPath = join(dir, 'root-cert.pem');

      if (existsSync(keyPath) && existsSync(certPath)) {
        Logger.info(`SPIRE root for '${cluster.trustDomain}' already exists, reusing`);
        continue;
      }

      Logger.info(`Generating independent SPIRE root for '${cluster.trustDomain}'...`);
      await CommandRunner.exec(`openssl genrsa -out "${keyPath}" 2048`);
      await CommandRunner.exec(
        `openssl req -new -x509 -days 3650 -key "${keyPath}" ` +
          `-out "${certPath}" -subj "/CN=SPIRE Root CA - ${cluster.name}"`
      );
    }

    Logger.success('Independent SPIRE roots ready');
  }
}

// ── EastWestGateway ───────────────────────────────────────────────────────────

/**
 * Deploys east-west gateways on each cluster for cross-cluster traffic.
 *
 * Configuration:
 * {
 *   clusters: [{ name, context }],  // Required
 *   namespace: string,              // default: 'istio-eastwest'
 *   method: 'istioctl' | 'helm',   // default: 'istioctl'
 *   helmRepo: string,               // required for helm method
 *   istioImage: string,             // required for helm method
 * }
 */
export class EastWestGateway {
  constructor(config) {
    this.config = config;
  }

  async deploy() {
    const namespace = this.config.namespace || 'istio-eastwest';
    const method = this.config.method || 'istioctl';
    const clusters = this.config.clusters;

    Logger.info(
      `Deploying east-west gateways (method: ${method}) on ${clusters.length} cluster(s)`
    );

    for (const cluster of clusters) {
      const contextFlag = cluster.context ? `--context ${cluster.context}` : '';
      const kubectlCtx = cluster.context ? `--context=${cluster.context}` : '';

      Logger.info(`Setting up east-west gateway on ${cluster.name}...`);

      await CommandRunner.exec(
        `kubectl ${kubectlCtx} create namespace ${namespace} --dry-run=client -o yaml | kubectl ${kubectlCtx} apply -f -`
      );

      if (method === 'helm') {
        await this.#deployViaHelm(cluster, namespace);
      } else {
        await IstioctlHelper.deployViaIstioctl(cluster, namespace, contextFlag);
      }

      await this.#waitForGatewayPod(namespace, kubectlCtx, cluster.name);
    }

    Logger.success('East-west gateways deployed on all clusters');
  }

  async cleanup() {
    const namespace = this.config.namespace || 'istio-eastwest';
    const method = this.config.method || 'istioctl';
    const clusters = this.config.clusters;

    Logger.info('Cleaning up east-west gateways...');

    for (const cluster of clusters) {
      const kubectlCtx = cluster.context ? `--context=${cluster.context}` : '';
      const helmCtx = cluster.context ? `--kube-context=${cluster.context}` : '';

      try {
        if (method === 'helm') {
          await CommandRunner.exec(
            `helm ${helmCtx} uninstall peering-eastwest -n ${namespace} || true`
          );
        } else {
          await CommandRunner.exec(
            `kubectl ${kubectlCtx} delete gateway istio-eastwest -n ${namespace} --ignore-not-found=true`
          );
        }

        await CommandRunner.exec(
          `kubectl ${kubectlCtx} delete namespace ${namespace} --ignore-not-found=true`
        );

        Logger.info(`East-west gateway removed from ${cluster.name}`);
      } catch {
        Logger.warn(`Could not fully clean east-west gateway from ${cluster.name}`);
      }
    }

    Logger.success('East-west gateways cleaned up');
  }

  async #deployViaHelm(cluster, _namespace) {
    const helmRepo = this.config.helmRepo || process.env.HELM_REPO;
    const istioImage = this.config.istioImage || process.env.ISTIO_IMAGE;

    if (!helmRepo)
      throw new Error('helmRepo is required for Helm-based east-west gateway deployment');
    if (!istioImage)
      throw new Error('istioImage is required for Helm-based east-west gateway deployment');

    const flags = {
      kubectl: cluster.context ? `--context=${cluster.context}` : '',
      helm: cluster.context ? `--kube-context=${cluster.context}` : '',
    };

    await PeeringInstaller.deployEastWest({ cluster, helmRepo, version: istioImage, flags });
  }

  async #waitForGatewayPod(namespace, kubectlCtx, clusterName) {
    Logger.info(`Waiting for east-west gateway pod on ${clusterName}...`);

    for (let i = 0; i < 30; i++) {
      const result = await CommandRunner.exec(
        `kubectl ${kubectlCtx} get pods -n ${namespace} -o json`,
        { ignoreError: true }
      );

      if (result.stdout) {
        try {
          const pods = JSON.parse(result.stdout);
          const running = (pods.items || []).some(
            p => p.status?.phase === 'Running' && p.status?.containerStatuses?.every(c => c.ready)
          );
          if (running) {
            Logger.success(`East-west gateway pod is running on ${clusterName}`);
            return;
          }
        } catch {
          /* continue polling */
        }
      }

      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    Logger.warn(`East-west gateway pod may not be fully ready on ${clusterName}`);
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function deepMerge(target, source) {
  if (!source) return target;
  if (!target) return source;
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const s = source[key],
      t = result[key];
    if (Array.isArray(s)) result[key] = [...s];
    else if (s && typeof s === 'object')
      result[key] = deepMerge(t && typeof t === 'object' ? t : {}, s);
    else result[key] = s;
  }
  return result;
}

// ── ClusterLinker ─────────────────────────────────────────────────────────────

const EW_GATEWAY_POLL_INTERVAL_MS = 10000;
const EW_GATEWAY_POLL_MAX = 36; // 6 minutes

/**
 * Links clusters for cross-cluster traffic in a multicluster Istio ambient mesh.
 * Discovers east-west gateway addresses and topology dynamically.
 *
 * Configuration:
 * {
 *   clusters: [{ name, context }],  // Required
 *   namespace: string,              // default: 'istio-eastwest'
 *   method: 'helm' | 'declarative', // Required
 *   helmRepo: string,               // Required for helm method
 *   istioImage: string,             // Required for helm method
 *   ewGatewayService: string,       // default: 'istio-eastwest'
 *   peeringRemoteValues: object,    // Optional: trustDomain, addressType, preferredDataplaneServiceType
 * }
 */
export class ClusterLinker {
  constructor(config) {
    this.config = config;
  }

  async deploy() {
    const { clusters, method } = this.config;
    Logger.info(`Linking ${clusters.length} clusters via ${method} method...`);

    const peerInfoMap = await this.#discoverAllPeerInfo();

    if (method === 'helm') {
      await this.#linkViaHelm(peerInfoMap);
    } else {
      await this.#linkViaDeclarative(peerInfoMap);
    }

    Logger.success('Clusters linked successfully');
    await this.#verifyLink();
  }

  async verify() {
    await this.#verifyLink();
  }

  async cleanup() {
    const { clusters, method, namespace = 'istio-eastwest' } = this.config;
    Logger.info('Cleaning up cluster links...');

    for (const cluster of clusters) {
      const peers = clusters.filter(c => c.name !== cluster.name);
      const ctx = cluster.context ? `--context=${cluster.context}` : '';
      const helmCtx = cluster.context ? `--kube-context=${cluster.context}` : '';

      if (method === 'helm') {
        await CommandRunner.exec(
          `helm ${helmCtx} uninstall peering-remote -n ${namespace} || true`,
          { ignoreError: true }
        );
      } else {
        for (const peer of peers) {
          await CommandRunner.exec(
            `kubectl ${ctx} delete gateway istio-remote-peer-${peer.name} -n ${namespace} --ignore-not-found=true`,
            { ignoreError: true }
          );
        }
      }
    }

    Logger.success('Cluster links cleaned up');
  }

  // ── Verification ───────────────────────────────────────────────────────────

  async #verifyLink() {
    const istioctl = await IstioctlHelper.resolve({
      istioImage: this.config.istioImage,
    });
    if (!istioctl) {
      Logger.warn('Skipping multicluster check: istioctl could not be resolved or downloaded');
      return;
    }

    const contexts = this.config.clusters
      .map(c => c.context)
      .filter(Boolean)
      .join(',');

    if (!contexts) {
      Logger.warn('Skipping multicluster check: no cluster contexts available');
      return;
    }

    const MAX_ATTEMPTS = 10;
    const INTERVAL_MS = 30000;

    let lastResult = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      Logger.info(`Running ${istioctl} multicluster check (attempt ${attempt}/${MAX_ATTEMPTS})...`);
      lastResult = await CommandRunner.exec(
        `${istioctl} multicluster check --contexts="${contexts}"`,
        { ignoreError: true }
      );

      if (!lastResult.exitCode) {
        const box = new BoxedOutput('istioctl multicluster check');
        box.open();
        const stdout = lastResult.stdout?.trim();
        const stderr = lastResult.stderr?.trim();
        if (stdout) for (const line of stdout.split('\n')) box.writeLine(line);
        if (stderr) for (const line of stderr.split('\n')) box.writeLine(line);
        if (!stdout && !stderr) box.writeLine('(no output)');
        box.close();
        Logger.success('Multicluster check passed');
        return;
      }

      if (attempt < MAX_ATTEMPTS) {
        Logger.warn('Check failed — retrying in 30s...');
        await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
      }
    }

    // All retries exhausted — print final result
    const box = new BoxedOutput('istioctl multicluster check');
    box.open();
    const stdout = lastResult.stdout?.trim();
    const stderr = lastResult.stderr?.trim();
    if (stdout) for (const line of stdout.split('\n')) box.writeLine(line);
    if (stderr) for (const line of stderr.split('\n')) box.writeLine(line);
    if (!stdout && !stderr) box.writeLine('(no output)');
    box.close();
    Logger.warn(
      'Multicluster check completed with warnings after all retries — review output above'
    );
  }

  // ── Discovery ──────────────────────────────────────────────────────────────

  async #discoverAllPeerInfo() {
    const { clusters } = this.config;
    Logger.info('Discovering east-west gateway peer info...');

    const entries = await Promise.all(
      clusters.map(async cluster => {
        const info = await this.#discoverPeerInfo(cluster);
        Logger.info(
          `  ${cluster.name}: ${info.address} (${info.addressType}, ${info.preferredDataplaneServiceType})` +
            (info.region ? `, region=${info.region}` : '') +
            (info.zone ? `, zone=${info.zone}` : '')
        );
        return [cluster.name, info];
      })
    );

    return Object.fromEntries(entries);
  }

  async #discoverPeerInfo(cluster) {
    const ns = this.config.namespace || 'istio-eastwest';
    const svc = this.config.ewGatewayService || 'istio-eastwest';
    const ctx = cluster.context ? `--context=${cluster.context}` : '';

    const svcTypeResult = await CommandRunner.exec(
      `kubectl ${ctx} get svc ${svc} -n ${ns} -o jsonpath="{.spec.type}"`,
      { ignoreError: true }
    );
    const svcType = svcTypeResult.stdout?.trim();
    const isNodePort = svcType === 'NodePort';
    const preferredDataplaneServiceType = isNodePort ? 'nodeport' : 'loadbalancer';

    const address = isNodePort
      ? await this.#getNodePortAddress(cluster, ns, svc)
      : await this.#getLBAddress(cluster, ns, svc);

    const addressType = this.#detectAddressType(address);

    const region =
      cluster.region ?? (await this.#detectNodeLabel(cluster, 'topology.kubernetes.io/region'));
    const zone =
      cluster.zone ?? (await this.#detectNodeLabel(cluster, 'topology.kubernetes.io/zone'));

    return { address, addressType, preferredDataplaneServiceType, region, zone };
  }

  async #getLBAddress(cluster, ns, svc) {
    const ctx = cluster.context ? `--context=${cluster.context}` : '';

    for (let i = 0; i < EW_GATEWAY_POLL_MAX; i++) {
      const result = await CommandRunner.exec(
        `kubectl ${ctx} get svc ${svc} -n ${ns}` +
          ` -o jsonpath="{.status.loadBalancer.ingress[0]['hostname','ip']}"`,
        { ignoreError: true }
      );
      const addr = result.stdout?.trim();
      if (addr) return addr;

      if (i === 0) Logger.info(`Waiting for LB address on ${cluster.name}...`);
      await new Promise(resolve => setTimeout(resolve, EW_GATEWAY_POLL_INTERVAL_MS));
    }

    throw new Error(`Timed out waiting for east-west gateway LB address on ${cluster.name}`);
  }

  async #getNodePortAddress(cluster, _ns, _svc) {
    const ctx = cluster.context ? `--context=${cluster.context}` : '';

    const nodeResult = await CommandRunner.exec(
      `kubectl ${ctx} get nodes -o jsonpath=` +
        `"{.items[0].status.addresses[?(@.type=='ExternalIP')].address}"`,
      { ignoreError: true }
    );
    const externalIP = nodeResult.stdout?.trim();
    if (externalIP) return externalIP;

    const internalResult = await CommandRunner.exec(
      `kubectl ${ctx} get nodes -o jsonpath=` +
        `"{.items[0].status.addresses[?(@.type=='InternalIP')].address}"`,
      { ignoreError: true }
    );
    const internalIP = internalResult.stdout?.trim();
    if (internalIP) return internalIP;

    throw new Error(`Could not determine node address for NodePort service on ${cluster.name}`);
  }

  async #detectNodeLabel(cluster, label) {
    const ctx = cluster.context ? `--context=${cluster.context}` : '';
    const result = await CommandRunner.exec(
      `kubectl ${ctx} get nodes -o jsonpath="{.items[0].metadata.labels['${label}']}"`,
      { ignoreError: true }
    );
    return result.stdout?.trim() || null;
  }

  #detectAddressType(address) {
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(address) ? 'IPAddress' : 'Hostname';
  }

  // ── Linking ────────────────────────────────────────────────────────────────

  async #linkViaHelm(peerInfoMap) {
    const {
      clusters,
      namespace = 'istio-eastwest',
      helmRepo,
      istioImage,
      peeringRemoteValues = {},
    } = this.config;

    // trustDomain may contain {{ cluster.name }} template — resolve per-peer
    const trustDomainPattern = peeringRemoteValues.trustDomain || 'cluster.local';
    const addressTypeOverride = peeringRemoteValues.addressType || null;
    const serviceTypeOverride = peeringRemoteValues.preferredDataplaneServiceType || null;

    for (const cluster of clusters) {
      const peers = clusters.filter(c => c.name !== cluster.name);
      const helmCtx = cluster.context ? `--kube-context=${cluster.context}` : '';

      const items = peers.map(peer => {
        const info = peerInfoMap[peer.name];
        // Resolve {{ cluster.name }} using the peer's name — trust domain is the REMOTE cluster's
        const trustDomain = trustDomainPattern.replace(/\{\{\s*cluster\.name\s*\}\}/g, peer.name);
        const item = {
          name: `istio-remote-peer-${peer.name}`,
          cluster: peer.name,
          network: peer.name,
          addressType: addressTypeOverride || info.addressType,
          address: info.address,
          preferredDataplaneServiceType: serviceTypeOverride || info.preferredDataplaneServiceType,
          trustDomain,
        };
        if (info.region) item.region = info.region;
        if (info.zone) item.zone = info.zone;
        return item;
      });

      await PeeringInstaller.deployRemote({
        cluster,
        helmRepo,
        version: istioImage,
        valuesObj: { remote: { create: true, items } },
        namespace,
        flags: { helm: helmCtx },
      });
    }
  }

  async #linkViaDeclarative(peerInfoMap) {
    const { clusters, namespace = 'istio-eastwest', peeringRemoteValues = {} } = this.config;

    // trustDomain may contain {{ cluster.name }} template — resolve per-peer
    const trustDomainPattern = peeringRemoteValues.trustDomain || null;
    const addressTypeOverride = peeringRemoteValues.addressType || null;
    const serviceTypeOverride = peeringRemoteValues.preferredDataplaneServiceType || null;

    for (const cluster of clusters) {
      const peers = clusters.filter(c => c.name !== cluster.name);
      const ctx = cluster.context ? `--context=${cluster.context}` : '';

      for (const peer of peers) {
        const info = peerInfoMap[peer.name];
        // Resolve {{ cluster.name }} using the peer's name — trust domain is the REMOTE cluster's
        const trustDomain = trustDomainPattern
          ? trustDomainPattern.replace(/\{\{\s*cluster\.name\s*\}\}/g, peer.name)
          : null;

        const gateway = buildRemotePeerGateway({
          peerName: peer.name,
          namespace,
          address: info.address,
          addressType: addressTypeOverride || info.addressType,
          trustDomain,
          region: info.region,
          zone: info.zone,
          preferredServiceType: serviceTypeOverride || info.preferredDataplaneServiceType,
        });

        const gwYaml = yaml.dump(gateway, { lineWidth: -1 });
        const tmpFile = join(
          tmpdir(),
          `.agentic-gateway-${cluster.name}-${peer.name}-${process.pid}.yaml`
        );
        writeFileSync(tmpFile, gwYaml);

        try {
          Logger.info(`Applying istio-remote-peer-${peer.name} on ${cluster.name}...`);
          await CommandRunner.exec(`kubectl ${ctx} apply -f ${tmpFile}`, { ignoreError: false });
        } finally {
          if (existsSync(tmpFile))
            try {
              unlinkSync(tmpFile);
            } catch {
              /* best effort */
            }
        }
      }
    }
  }
}

// ── PeeringInstaller ──────────────────────────────────────────────────────────

/**
 * Shared Helm installers for peering components.
 * Used by both helm and operator install paths.
 */
export class PeeringInstaller {
  /**
   * Deploy east-west gateway (peering-eastwest chart) via Helm.
   * Profile component values must already be template-resolved by the caller.
   *
   * @param {object} cluster           - { name, context }
   * @param {string} helmRepo          - OCI Helm repo (cfg.helmIstioRepo)
   * @param {string} version           - Chart version (cfg.istioImage)
   * @param {object} [componentValues] - Pre-resolved profile values for peering-eastwest
   * @param {object} flags             - { kubectl, helm }
   * @param {object} [logger]          - Logger or SpinnerLogger (default: Logger)
   */
  static async deployEastWest({ cluster, helmRepo, version, componentValues = {}, flags, logger }) {
    const log = logger || Logger;
    const baseValues = {
      eastwest: {
        create: true,
        cluster: cluster.name,
        network: cluster.name,
        deployment: {},
      },
    };

    const mergedValues = deepMerge(baseValues, componentValues);
    const valuesYaml = yaml.dump(mergedValues, { lineWidth: -1 });
    const tempFile = join(tmpdir(), `.agentic-peering-ew-${cluster.name}-${process.pid}.yaml`);
    writeFileSync(tempFile, valuesYaml);

    try {
      await CommandRunner.exec(
        `kubectl ${flags.kubectl} create namespace istio-eastwest --dry-run=client -o yaml | kubectl ${flags.kubectl} apply -f -`,
        { ignoreError: true }
      );

      const result = await CommandRunner.exec(
        `helm ${flags.helm} upgrade --install peering-eastwest ` +
          `oci://${helmRepo}/peering ` +
          `--version ${version} ` +
          `--namespace istio-eastwest ` +
          `--create-namespace ` +
          `--wait --timeout 5m ` +
          `-f ${tempFile}`,
        { ignoreError: true }
      );
      if (result.exitCode) {
        throw new Error(`Failed to deploy peering-eastwest: ${result.stderr || result.stdout}`);
      }
      log.logSuccess(`peering-eastwest gateway deployed on ${cluster.name}`);
    } finally {
      try {
        unlinkSync(tempFile);
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * Deploy peering-remote chart on a single cluster.
   * Caller builds valuesObj with remote topology (addresses, regions, etc.).
   *
   * @param {object} cluster    - { name, context }
   * @param {string} helmRepo
   * @param {string} version
   * @param {object} valuesObj  - { remote: { create: true, items: [...] } }
   * @param {string} namespace
   * @param {object} flags      - { helm }
   * @param {object} [logger]
   */
  static async deployRemote({ cluster, helmRepo, version, valuesObj, namespace, flags, logger }) {
    const log = logger || Logger;
    const valuesFile = join(
      tmpdir(),
      `.agentic-peering-remote-${cluster.name}-${process.pid}.yaml`
    );
    writeFileSync(valuesFile, yaml.dump(valuesObj, { lineWidth: -1 }));

    try {
      log.logInfo(`Installing peering-remote on ${cluster.name}...`);
      await CommandRunner.exec(
        `helm ${flags.helm} upgrade --install peering-remote ` +
          `oci://${helmRepo}/peering ` +
          `--version ${version} --namespace ${namespace} --create-namespace ` +
          `--wait --timeout 5m -f ${valuesFile}`,
        { ignoreError: false }
      );
      log.logInfo(`peering-remote installed on ${cluster.name}`);
    } finally {
      if (existsSync(valuesFile))
        try {
          unlinkSync(valuesFile);
        } catch {
          /* best effort */
        }
    }
  }
}
