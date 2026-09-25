import path from 'path';
import { fileURLToPath } from 'url';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import yaml from 'js-yaml';
import { AddonFeature } from '../../src/lib/feature.js';
import {
  KubernetesHelper,
  CommandRunner,
  waitForPublicUrl,
  nlbSourceRangeAnnotations,
} from '../../src/lib/common.js';
import { ArctlHelper } from '../../src/lib/arctl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(__dirname, 'config');

const ENTERPRISE_VERSION = '2026.5.4';
const ENTERPRISE_REGISTRY = 'oci://us-docker.pkg.dev/solo-public/agentregistry-enterprise/helm';
const CHART_NAME = 'agentregistry-enterprise';
const HELM_RELEASE = 'agentregistry';

// Grants AgentRegistry broad AWS access for managing BedrockAgentCore resources.
// NotAction allows all non-IAM/org/account services, plus a few explicit exceptions.
const GENERAL_ACCESS_POLICY = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      NotAction: ['iam:*', 'organizations:*', 'account:*'],
      Resource: '*',
    },
    {
      Effect: 'Allow',
      Action: [
        'account:GetAccountInformation',
        'account:GetGovCloudAccountInformation',
        'account:GetPrimaryEmail',
        'account:ListRegions',
        'iam:CreateServiceLinkedRole',
        'iam:DeleteServiceLinkedRole',
        'iam:ListRoles',
        'organizations:DescribeEffectivePolicy',
        'organizations:DescribeOrganization',
      ],
      Resource: '*',
    },
  ],
};

// BedrockAgentCore policy part 1 (core ops): bedrock-agentcore:*, IAM, SecretsManager,
// KMS, S3 gateway, Lambda, API Gateway, CloudWatch logs.
const BEDROCK_AGENTCORE_POLICY_1 = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'BedrockAgentCoreFullAccess',
      Effect: 'Allow',
      Action: ['bedrock-agentcore:*'],
      Resource: 'arn:aws:bedrock-agentcore:*:*:*',
    },
    {
      Sid: 'IAMListAccess',
      Effect: 'Allow',
      Action: [
        'iam:GetRole',
        'iam:GetRolePolicy',
        'iam:ListAttachedRolePolicies',
        'iam:ListRolePolicies',
        'iam:ListRoles',
      ],
      Resource: 'arn:aws:iam::*:role/*',
    },
    {
      Sid: 'BedrockAgentCorePassRoleAccess',
      Effect: 'Allow',
      Action: 'iam:PassRole',
      Resource: 'arn:aws:iam::*:role/*BedrockAgentCore*',
      Condition: {
        StringEquals: { 'iam:PassedToService': 'bedrock-agentcore.amazonaws.com' },
      },
    },
    {
      Sid: 'SecretsManagerAccess',
      Effect: 'Allow',
      Action: [
        'secretsmanager:CreateSecret',
        'secretsmanager:PutSecretValue',
        'secretsmanager:GetSecretValue',
        'secretsmanager:DeleteSecret',
      ],
      Resource: 'arn:aws:secretsmanager:*:*:secret:bedrock-agentcore*',
    },
    {
      Sid: 'BedrockAgentCoreKMSReadAccess',
      Effect: 'Allow',
      Action: ['kms:ListKeys', 'kms:DescribeKey'],
      Resource: ['arn:aws:kms:*:*:key/*'],
      Condition: { StringEquals: { 'aws:ResourceAccount': '${aws:PrincipalAccount}' } },
    },
    {
      Sid: 'BedrockAgentCoreKMSAccess',
      Effect: 'Allow',
      Action: ['kms:Decrypt', 'kms:GenerateDataKey', 'kms:ListGrants'],
      Resource: ['arn:aws:kms:*:*:key/*'],
      Condition: {
        StringEquals: { 'aws:ResourceAccount': '${aws:PrincipalAccount}' },
        'ForAnyValue:StringEquals': { 'aws:CalledVia': ['bedrock-agentcore.amazonaws.com'] },
      },
    },
    {
      Sid: 'BedrockAgentCoreKMSGrantsAccess',
      Effect: 'Allow',
      Action: ['kms:CreateGrant'],
      Resource: ['arn:aws:kms:*:*:key/*'],
      Condition: {
        StringEquals: { 'kms:GrantConstraintType': 'EncryptionContextSubset' },
        StringLike: {
          'kms:ViaService': ['bedrock-agentcore.*.amazonaws.com'],
          'kms:EncryptionContext:aws:bedrock-agentcore-gateway:arn':
            'arn:aws:bedrock-agentcore:*:*:gateway/*',
        },
        'ForAllValues:StringEquals': { 'kms:GrantOperations': ['Decrypt', 'GenerateDataKey'] },
      },
    },
    {
      Sid: 'BedrockAgentCoreS3Access',
      Effect: 'Allow',
      Action: ['s3:GetObject'],
      Resource: ['arn:aws:s3:::bedrock-agentcore-gateway-*'],
      Condition: {
        StringEquals: {
          'aws:CalledViaLast': 'bedrock-agentcore.amazonaws.com',
          's3:ResourceAccount': '${aws:PrincipalAccount}',
        },
      },
    },
    {
      Sid: 'BedrockAgentCoreGatewayLambdaAccess',
      Effect: 'Allow',
      Action: ['lambda:ListFunctions'],
      Resource: ['arn:aws:lambda:*:*:*'],
    },
    {
      Sid: 'BedrockAgentCoreGatewayApiGateway',
      Effect: 'Allow',
      Action: ['apigateway:GET'],
      Resource: ['arn:aws:apigateway:*::/restapis/*/stages/*/exports/*'],
    },
    {
      Sid: 'LoggingAccess',
      Effect: 'Allow',
      Action: [
        'logs:Get*',
        'logs:List*',
        'logs:StartQuery',
        'logs:StopQuery',
        'logs:Describe*',
        'logs:TestMetricFilter',
        'logs:FilterLogEvents',
      ],
      Resource: [
        'arn:aws:logs:*:*:log-group:/aws/bedrock-agentcore/*',
        'arn:aws:logs:*:*:log-group:/aws/application-signals/data:*',
        'arn:aws:logs:*:*:log-group:aws/spans:*',
      ],
    },
  ],
};

// BedrockAgentCore policy part 2: observability, service-linked roles, S3 runtime,
// ECR, CloudTrail, Bedrock invoke, and evaluation Lambda.
const BEDROCK_AGENTCORE_POLICY_2 = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'ObservabilityReadOnlyPermissions',
      Effect: 'Allow',
      Action: [
        'application-autoscaling:DescribeScalingPolicies',
        'application-signals:BatchGet*',
        'application-signals:Get*',
        'application-signals:List*',
        'autoscaling:Describe*',
        'cloudwatch:BatchGet*',
        'cloudwatch:Describe*',
        'cloudwatch:GenerateQuery',
        'cloudwatch:Get*',
        'cloudwatch:List*',
        'oam:ListSinks',
        'rum:BatchGet*',
        'rum:Get*',
        'rum:List*',
        'synthetics:Describe*',
        'synthetics:Get*',
        'synthetics:List*',
        'xray:BatchGet*',
        'xray:Get*',
        'xray:List*',
        'xray:StartTraceRetrieval',
        'xray:CancelTraceRetrieval',
        'logs:DescribeLogGroups',
        'logs:StartLiveTail',
        'logs:StopLiveTail',
      ],
      Resource: '*',
    },
    {
      Sid: 'TransactionSearchXRayPermissions',
      Effect: 'Allow',
      Action: [
        'xray:GetTraceSegmentDestination',
        'xray:UpdateTraceSegmentDestination',
        'xray:GetIndexingRules',
        'xray:UpdateIndexingRule',
      ],
      Resource: '*',
    },
    {
      Sid: 'TransactionSearchLogGroupPermissions',
      Effect: 'Allow',
      Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutRetentionPolicy'],
      Resource: [
        'arn:aws:logs:*:*:log-group:/aws/application-signals/data:*',
        'arn:aws:logs:*:*:log-group:aws/spans:*',
      ],
    },
    {
      Sid: 'TransactionSearchLogsPermissions',
      Effect: 'Allow',
      Action: ['logs:DescribeResourcePolicies', 'logs:PutResourcePolicy'],
      Resource: ['*'],
      Condition: { StringEquals: { 'aws:ResourceAccount': '${aws:PrincipalAccount}' } },
    },
    {
      Sid: 'TransactionSearchApplicationSignalsPermissions',
      Effect: 'Allow',
      Action: ['application-signals:StartDiscovery'],
      Resource: '*',
    },
    {
      Sid: 'CloudWatchApplicationSignalsCreateServiceLinkedRolePermissions',
      Effect: 'Allow',
      Action: 'iam:CreateServiceLinkedRole',
      Resource:
        'arn:aws:iam::*:role/aws-service-role/application-signals.cloudwatch.amazonaws.com/AWSServiceRoleForCloudWatchApplicationSignals',
      Condition: {
        StringLike: { 'iam:AWSServiceName': 'application-signals.cloudwatch.amazonaws.com' },
      },
    },
    {
      Sid: 'CloudWatchApplicationSignalsGetRolePermissions',
      Effect: 'Allow',
      Action: 'iam:GetRole',
      Resource:
        'arn:aws:iam::*:role/aws-service-role/application-signals.cloudwatch.amazonaws.com/AWSServiceRoleForCloudWatchApplicationSignals',
    },
    {
      Sid: 'CreateBedrockAgentCoreNetworkServiceLinkedRolePermissions',
      Effect: 'Allow',
      Action: 'iam:CreateServiceLinkedRole',
      Resource:
        'arn:aws:iam::*:role/aws-service-role/network.bedrock-agentcore.amazonaws.com/AWSServiceRoleForBedrockAgentCoreNetwork',
      Condition: {
        StringEquals: { 'iam:AWSServiceName': 'network.bedrock-agentcore.amazonaws.com' },
      },
    },
    {
      Sid: 'CreateBedrockAgentCoreRuntimeIdentityServiceLinkedRolePermissions',
      Effect: 'Allow',
      Action: 'iam:CreateServiceLinkedRole',
      Resource:
        'arn:aws:iam::*:role/aws-service-role/runtime-identity.bedrock-agentcore.amazonaws.com/AWSServiceRoleForBedrockAgentCoreRuntimeIdentity',
      Condition: {
        StringEquals: { 'iam:AWSServiceName': 'runtime-identity.bedrock-agentcore.amazonaws.com' },
      },
    },
    {
      Sid: 'CloudWatchApplicationSignalsCloudTrailPermissions',
      Effect: 'Allow',
      Action: ['cloudtrail:CreateServiceLinkedChannel'],
      Resource: 'arn:aws:cloudtrail:*:*:channel/aws-service-channel/application-signals/*',
    },
    {
      Sid: 'BedrockAgentCoreRuntimeS3WriteAccess',
      Effect: 'Allow',
      Action: ['s3:CreateBucket', 's3:PutBucketPolicy', 's3:PutBucketVersioning', 's3:PutObject'],
      Resource: ['arn:aws:s3:::bedrock-agentcore-runtime-*'],
      Condition: { StringEquals: { 's3:ResourceAccount': '${aws:PrincipalAccount}' } },
    },
    {
      Sid: 'BedrockAgentCoreRuntimeS3ReadAccess',
      Effect: 'Allow',
      Action: ['s3:GetObject', 's3:GetObjectVersion', 's3:ListBucket', 's3:ListBucketVersions'],
      Resource: 'arn:aws:s3:::*',
      Condition: { StringEquals: { 's3:ResourceAccount': '${aws:PrincipalAccount}' } },
    },
    {
      Sid: 'BedrockAgentCoreRuntimeS3ListAccess',
      Effect: 'Allow',
      Action: ['s3:ListAllMyBuckets'],
      Resource: '*',
      Condition: { StringEquals: { 's3:ResourceAccount': '${aws:PrincipalAccount}' } },
    },
    {
      Sid: 'BedrockAgentCoreRuntimeECRAccess',
      Effect: 'Allow',
      Action: ['ecr:DescribeRepositories', 'ecr:DescribeImages', 'ecr:ListImages'],
      Resource: ['arn:aws:ecr:*:*:repository/*'],
    },
    {
      Sid: 'AgentCoreEvaluationCloudWatchLogCreate',
      Effect: 'Allow',
      Action: ['logs:CreateLogGroup'],
      Resource: ['arn:aws:logs:*:*:log-group:/aws/bedrock-agentcore/evaluations/*'],
    },
    {
      Sid: 'AgentCoreEvaluationCloudWatchLogIndexAccess',
      Effect: 'Allow',
      Action: ['logs:PutIndexPolicy', 'logs:DescribeIndexPolicies'],
      Resource: ['arn:aws:logs:*:*:log-group:aws/spans', 'arn:aws:logs:*:*:log-group:aws/spans:*'],
    },
    {
      Sid: 'AgentCoreEvaluationBedrockInvokeAccess',
      Effect: 'Allow',
      Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      Resource: [
        'arn:aws:bedrock:*::foundation-model/*',
        'arn:aws:bedrock:*:*:inference-profile/*',
      ],
    },
    {
      Sid: 'AgentCoreEvaluationLambdaAccess',
      Effect: 'Allow',
      Action: ['lambda:InvokeFunction', 'lambda:GetFunction'],
      Resource: 'arn:aws:lambda:*:*:function:*',
    },
  ],
};

/**
 * AgentregistryFeature: installs Solo Enterprise agentregistry, a registry for MCP
 * servers that enables discovery and governance of AI tool backends.
 *
 * Configuration:
 * {
 *   namespace: string,           // Default: 'agentregistry-system'
 *   version: string,             // Default: ENTERPRISE_VERSION
 *   chartOci: string,            // Default: ENTERPRISE_REGISTRY/CHART_NAME (OCI chart URL)
 *   kubeContext: string,         // Optional: kube context for multi-cluster
 *   ambient: boolean,            // Label namespace istio.io/dataplane-mode=ambient. Default: false.
 *                                // Required to reach a cross-cluster *.mesh.internal kagent
 *                                // Runtime: outside the ambient mesh that suffix doesn't resolve
 *                                // (confirmed live: NXDOMAIN from a non-ambient namespace).
 *   hostname: string,            // Optional: public hostname; enables LB + external-dns when set
 *   externalDns: boolean,        // Optional: explicit override; auto-detected when external-dns addon present
 *   oidc: {
 *     issuer: string,            // Explicit OIDC issuer URL (overrides computed value)
 *     keycloakHostname: string,  // Keycloak hostname; issuer computed from this
 *     keycloakTlsEnabled: bool,  // Whether Keycloak uses HTTPS (default: false)
 *     realm: string,             // Keycloak realm name (default: 'agentregistry')
 *     clientId: string,          // Backend client ID (default: 'ar-backend')
 *     clientSecret: string,      // Backend client secret
 *     publicClientId: string,    // UI client ID (default: 'ar-ui')
 *     roleClaim: string,         // JWT role claim (default: 'Groups')
 *     superuserRole: string,     // Superuser group name (default: 'admins')
 *   },
 *   agentcore: {
 *     enabled: boolean,          // Gate: set true to run the full AgentCore AWS setup
 *     iamUserName: string,       // IAM user for AgentRegistry ↔ AWS auth (default: 'agentregistry-agentcore')
 *     stackName: string,         // CloudFormation stack name (default: 'agentregistry-agentcore')
 *     runtimeName: string,       // arctl Runtime name in AgentRegistry (default: 'aws-agentcore')
 *     region: string,            // AWS region (default: auto-detected via sts get-caller-identity)
 *     telemetryEndpoint: string, // Optional OTel endpoint e.g. http://<lb>:4318
 *     arctl: {
 *       version: string,         // arctl version override
 *       clientId: string,        // OIDC client ID for arctl login (default: 'ar-cli')
 *     }
 *   }
 * }
 *
 * Env: ENTERPRISE_AGENTREGISTRY_LICENSE required for enterprise licensing.
 */
export class AgentregistryFeature extends AddonFeature {
  constructor(name, config = {}) {
    super(name, config);
    this.enterprise = config.enterprise === true;
    this.namespace = config.namespace || 'agentregistry-system';
    this.version = config.version || ENTERPRISE_VERSION;
    this.chartOci = config.chartOci || `${ENTERPRISE_REGISTRY}/${CHART_NAME}`;
    this.kubeContext = config.kubeContext || null;
    this.ambient = config.ambient === true;
    this.hostname = config.hostname || null;
    const clusterAddons = config.clusterAddons || [];
    this.externalDns = config.externalDns === true || clusterAddons.includes('external-dns');
    const tls = config.tls || {};
    this.tlsEnabled = !!(tls.secretName || tls.issuer || tls.enabled);
    this.tlsSecretName = tls.secretName || 'agentregistry-tls';
    this.tlsIssuer = tls.issuer || 'letsencrypt-dns';
    this.sourceRanges = config.sourceRanges || null;

    const oidc = config.oidc || {};
    if (oidc.issuer) {
      this.oidcIssuer = oidc.issuer;
    } else if (oidc.keycloakHostname) {
      const scheme = oidc.keycloakTlsEnabled ? 'https' : 'http';
      const realm = oidc.realm || 'agentregistry';
      this.oidcIssuer = `${scheme}://${oidc.keycloakHostname}/realms/${realm}`;
    } else {
      this.oidcIssuer = null;
    }
    this.oidcClientId = oidc.clientId || 'ar-backend';
    this.oidcClientSecret = oidc.clientSecret || null;
    this.oidcPublicClientId = oidc.publicClientId || 'ar-ui';
    this.oidcRoleClaim = oidc.roleClaim || 'Groups';
    this.oidcSuperuserRole = oidc.superuserRole || 'admins';

    // Outbound OIDC identity used when AgentRegistry calls kagent-enterprise.
    // Falls back to main oidc.* values when unset (same issuer/client for both flows).
    const kagentOutbound = config.kagentOutboundOidc || {};
    if (kagentOutbound.issuer) {
      this.kagentOutboundOidcIssuer = kagentOutbound.issuer;
    } else if (kagentOutbound.keycloakHostname || oidc.keycloakHostname) {
      const host = kagentOutbound.keycloakHostname || oidc.keycloakHostname;
      const tlsEnabled = kagentOutbound.keycloakTlsEnabled ?? oidc.keycloakTlsEnabled ?? false;
      const scheme = tlsEnabled ? 'https' : 'http';
      const realm = kagentOutbound.realm || 'kagent';
      this.kagentOutboundOidcIssuer = `${scheme}://${host}/realms/${realm}`;
    } else {
      this.kagentOutboundOidcIssuer = null;
    }
    this.kagentOutboundOidcClientId = kagentOutbound.clientId || null;
    this.kagentOutboundOidcClientSecret = kagentOutbound.clientSecret || null;

    const otelGateway = config.otelGateway || {};
    this.otelGateway = otelGateway.enabled
      ? {
          hostname: otelGateway.hostname || null,
          upstreamEndpoint: otelGateway.upstreamEndpoint || null,
          tlsSecretName: otelGateway.tls?.secretName || 'agentregistry-telemetry-tls',
          tlsIssuer: otelGateway.tls?.issuer || 'letsencrypt-dns',
        }
      : null;

    const agentcore = config.agentcore || {};
    this.agentcore = agentcore.enabled
      ? {
          iamUserName: agentcore.iamUserName || 'agentregistry-agentcore',
          stackName: agentcore.stackName || 'agentregistry-agentcore',
          runtimeName: agentcore.runtimeName || 'aws-agentcore',
          region: agentcore.region || null,
          telemetryEndpoint: agentcore.telemetryEndpoint || null,
          networkId: agentcore.networkId || null,
          privateSubnetId: agentcore.privateSubnetId || null,
          securityGroupIds: agentcore.securityGroupIds || [],
          arctlVersion: agentcore.arctl?.version || undefined,
          arctlClientId: agentcore.arctl?.clientId || 'ar-cli',
        }
      : null;
  }

  validate() {
    if (this.enterprise && !process.env.ENTERPRISE_AGENTREGISTRY_LICENSE) {
      throw new Error(
        'ENTERPRISE_AGENTREGISTRY_LICENSE environment variable is required for agentregistry Enterprise'
      );
    }
    return true;
  }

  async deploy() {
    this.log(`Installing agentregistry Enterprise ${this.version}`);
    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];

    if (this.ambient) {
      await KubernetesHelper.ensureNamespace(this.namespace, this.spinner, this.kubeContext);
      await KubernetesHelper.kubectl(
        [
          ...(this.kubeContext ? [`--context=${this.kubeContext}`] : []),
          'label',
          'namespace',
          this.namespace,
          'istio.io/dataplane-mode=ambient',
          '--overwrite',
        ],
        { spinner: this.spinner }
      );
    }

    const helmArgs = [
      'upgrade',
      '-i',
      HELM_RELEASE,
      this.chartOci,
      '-n',
      this.namespace,
      '--create-namespace',
      '--version',
      this.version,
      '--wait',
      '--timeout',
      '10m',
      '--values',
      path.join(CONFIG_DIR, 'values.yaml'),
      ...(this.enterprise
        ? [
            '--set',
            'licensing.createSecret=true',
            '--set-string',
            `licensing.licenseKey=${process.env.ENTERPRISE_AGENTREGISTRY_LICENSE}`,
          ]
        : []),
      ...helmCtxArgs,
    ];

    if (this.hostname && this.tlsEnabled) {
      // TLS via agentgateway Gateway; service stays ClusterIP
    } else if (this.hostname && this.externalDns) {
      helmArgs.push(
        '--set',
        'service.type=LoadBalancer',
        '--set-string',
        `service.annotations.external-dns\\.alpha\\.kubernetes\\.io/hostname=${this.hostname}`
      );
      this.log(`Service: LoadBalancer with external-dns hostname ${this.hostname}`, 'info');
    }

    if (this.oidcIssuer) {
      helmArgs.push(
        '--set',
        `oidc.issuer=${this.oidcIssuer}`,
        '--set',
        `oidc.clientId=${this.oidcClientId}`,
        '--set',
        `oidc.publicClientId=${this.oidcPublicClientId}`,
        '--set',
        `oidc.roleClaim=${this.oidcRoleClaim}`,
        '--set',
        `oidc.superuserRole=${this.oidcSuperuserRole}`
      );
      if (this.oidcClientSecret) {
        helmArgs.push('--set-string', `oidc.clientSecret=${this.oidcClientSecret}`);
      }
    }

    if (this.kagentOutboundOidcClientId) {
      if (this.kagentOutboundOidcIssuer) {
        helmArgs.push('--set', `kagent.outboundAuth.oidc.issuer=${this.kagentOutboundOidcIssuer}`);
      }
      helmArgs.push(
        '--set',
        `kagent.outboundAuth.oidc.clientId=${this.kagentOutboundOidcClientId}`
      );
      if (this.kagentOutboundOidcClientSecret) {
        helmArgs.push(
          '--set-string',
          `kagent.outboundAuth.oidc.clientSecret=${this.kagentOutboundOidcClientSecret}`
        );
      }
    }

    await KubernetesHelper.helm(helmArgs, { spinner: this.spinner });
    await KubernetesHelper.assertHelmDeployed(HELM_RELEASE, this.namespace, this.kubeContext);

    if (this.hostname && this.tlsEnabled) {
      await this._applyHttpsResources();
      await waitForPublicUrl(this.hostname, {
        path: '/health',
        spinner: this.spinner,
        log: (msg, level) => this.log(msg, level),
      });
    }

    if (this.otelGateway) {
      await this._deployOtelGateway();
    }

    if (this.agentcore) {
      await this._setupAgentcore();
    }

    const accessUrl = this.hostname ? ` Access at https://${this.hostname}` : '';
    this.log(`agentregistry Enterprise installed successfully.${accessUrl}`, 'success');
  }

  async _applyHttpsResources() {
    this.log(`Configuring HTTPS for agentregistry at https://${this.hostname}...`, 'info');

    await this.applyResource(
      {
        apiVersion: 'cert-manager.io/v1',
        kind: 'Certificate',
        metadata: { name: 'agentregistry-tls', namespace: this.namespace },
        spec: {
          secretName: this.tlsSecretName,
          issuerRef: { name: this.tlsIssuer, kind: 'ClusterIssuer' },
          dnsNames: [this.hostname],
        },
      },
      this.kubeContext
    );

    const nlbAnnotations = nlbSourceRangeAnnotations(this.sourceRanges);

    await this.applyResource(
      {
        apiVersion: 'gateway.networking.k8s.io/v1',
        kind: 'Gateway',
        metadata: { name: 'agentregistry-ui-https', namespace: this.namespace },
        spec: {
          gatewayClassName: 'istio',
          listeners: [
            {
              name: 'https',
              port: 443,
              protocol: 'HTTPS',
              hostname: this.hostname,
              tls: {
                mode: 'Terminate',
                certificateRefs: [{ name: this.tlsSecretName, kind: 'Secret' }],
              },
              allowedRoutes: { namespaces: { from: 'Same' } },
            },
          ],
          ...(nlbAnnotations ? { infrastructure: { annotations: nlbAnnotations } } : {}),
        },
      },
      this.kubeContext
    );

    await this.applyResource(
      {
        apiVersion: 'gateway.networking.k8s.io/v1',
        kind: 'HTTPRoute',
        metadata: { name: 'agentregistry-ui', namespace: this.namespace },
        spec: {
          parentRefs: [
            {
              group: 'gateway.networking.k8s.io',
              kind: 'Gateway',
              name: 'agentregistry-ui-https',
              namespace: this.namespace,
            },
          ],
          hostnames: [this.hostname],
          rules: [
            {
              backendRefs: [{ name: 'agentregistry-enterprise-server', port: 12121 }],
              matches: [{ path: { type: 'PathPrefix', value: '/' } }],
            },
          ],
        },
      },
      this.kubeContext
    );

    this.log('HTTPS resources applied', 'info');
  }

  async _deployOtelGateway() {
    const cfg = this.otelGateway;
    this.log(
      `Deploying OTel Gateway for AgentCore telemetry at https://${cfg.hostname}...`,
      'info'
    );

    const otelCollectorConfig = {
      receivers: {
        otlp: {
          protocols: {
            http: { endpoint: '0.0.0.0:4318' },
          },
        },
      },
      exporters: {
        otlphttp: {
          endpoint: cfg.upstreamEndpoint,
          tls: { insecure: true },
        },
      },
      service: {
        pipelines: {
          traces: { receivers: ['otlp'], exporters: ['otlphttp'] },
          metrics: { receivers: ['otlp'], exporters: ['otlphttp'] },
          logs: { receivers: ['otlp'], exporters: ['otlphttp'] },
        },
      },
    };

    await this.applyResource(
      {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: 'agentregistry-otel-gateway-config', namespace: this.namespace },
        data: { 'config.yaml': yaml.dump(otelCollectorConfig, { lineWidth: -1, indent: 2 }) },
      },
      this.kubeContext
    );

    await this.applyResource(
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'agentregistry-otel-gateway', namespace: this.namespace },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: 'agentregistry-otel-gateway' } },
          template: {
            metadata: { labels: { app: 'agentregistry-otel-gateway' } },
            spec: {
              containers: [
                {
                  name: 'otel-collector',
                  image: 'otel/opentelemetry-collector-contrib:0.128.0',
                  args: ['--config=/conf/config.yaml'],
                  ports: [{ containerPort: 4318, name: 'otlp-http' }],
                  volumeMounts: [{ name: 'config', mountPath: '/conf' }],
                },
              ],
              volumes: [
                {
                  name: 'config',
                  configMap: { name: 'agentregistry-otel-gateway-config' },
                },
              ],
            },
          },
        },
      },
      this.kubeContext
    );

    await this.applyResource(
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'agentregistry-otel-gateway', namespace: this.namespace },
        spec: {
          selector: { app: 'agentregistry-otel-gateway' },
          ports: [{ name: 'otlp-http', port: 4318, targetPort: 4318, protocol: 'TCP' }],
          type: 'ClusterIP',
        },
      },
      this.kubeContext
    );

    await this.applyResource(
      {
        apiVersion: 'cert-manager.io/v1',
        kind: 'Certificate',
        metadata: { name: cfg.tlsSecretName, namespace: this.namespace },
        spec: {
          secretName: cfg.tlsSecretName,
          issuerRef: { name: cfg.tlsIssuer, kind: 'ClusterIssuer' },
          dnsNames: [cfg.hostname],
        },
      },
      this.kubeContext
    );

    await this.applyResource(
      {
        apiVersion: 'gateway.networking.k8s.io/v1',
        kind: 'Gateway',
        metadata: { name: 'agentregistry-telemetry-https', namespace: this.namespace },
        spec: {
          gatewayClassName: 'enterprise-agentgateway',
          listeners: [
            {
              name: 'https',
              port: 443,
              protocol: 'HTTPS',
              hostname: cfg.hostname,
              tls: {
                mode: 'Terminate',
                certificateRefs: [{ name: cfg.tlsSecretName, kind: 'Secret' }],
              },
              allowedRoutes: { namespaces: { from: 'Same' } },
            },
          ],
        },
      },
      this.kubeContext
    );

    await this.applyResource(
      {
        apiVersion: 'gateway.networking.k8s.io/v1',
        kind: 'HTTPRoute',
        metadata: { name: 'agentregistry-telemetry', namespace: this.namespace },
        spec: {
          parentRefs: [
            {
              group: 'gateway.networking.k8s.io',
              kind: 'Gateway',
              name: 'agentregistry-telemetry-https',
              namespace: this.namespace,
            },
          ],
          hostnames: [cfg.hostname],
          rules: [
            {
              backendRefs: [{ name: 'agentregistry-otel-gateway', port: 4318 }],
              matches: [{ path: { type: 'PathPrefix', value: '/' } }],
            },
          ],
        },
      },
      this.kubeContext
    );

    this.log(`OTel Gateway deployed — external endpoint: https://${cfg.hostname}`, 'success');
  }

  async _cleanupOtelGateway() {
    await this.deleteResource(
      'HTTPRoute',
      'agentregistry-telemetry',
      this.namespace,
      this.kubeContext
    );
    await this.deleteResource(
      'Gateway',
      'agentregistry-telemetry-https',
      this.namespace,
      this.kubeContext
    );
    await this.deleteResource(
      'Certificate',
      this.otelGateway.tlsSecretName,
      this.namespace,
      this.kubeContext
    );
    await this.deleteResource(
      'Service',
      'agentregistry-otel-gateway',
      this.namespace,
      this.kubeContext
    );
    await this.deleteResource(
      'Deployment',
      'agentregistry-otel-gateway',
      this.namespace,
      this.kubeContext
    );
    await this.deleteResource(
      'ConfigMap',
      'agentregistry-otel-gateway-config',
      this.namespace,
      this.kubeContext
    );
  }

  /**
   * Full AgentCore AWS setup:
   *  1. Get AWS account ID
   *  2. Create IAM user + attach managed policies (general-access, bedrock-agentcore-1, bedrock-agentcore-2)
   *  3. Create IAM access key → helm upgrade injects credentials into agentregistry pod
   *  4. arctl runtime setup → generates CloudFormation template + ExternalId
   *  5. Deploy CloudFormation stack → obtain cross-account RoleArn
   *  6. arctl apply Runtime (BedrockAgentCore) with roleArn + externalId
   */
  async _setupAgentcore() {
    const cfg = this.agentcore;
    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];

    // ── 1. AWS account ID ──────────────────────────────────────────────────
    this.log('Detecting AWS account ID...', 'info');
    const accountIdResult = await CommandRunner.exec(
      'aws sts get-caller-identity --query Account --output text'
    );
    const accountId = accountIdResult.stdout?.trim();
    if (!accountId) throw new Error('agentcore setup: failed to detect AWS account ID');
    const region = cfg.region || null;
    const regionFlag = region ? `--region ${region}` : '';
    this.log(`AWS account: ${accountId}${region ? ` / region: ${region}` : ''}`, 'info');

    // ── 2. IAM user (idempotent) ───────────────────────────────────────────
    this.log(`Creating IAM user "${cfg.iamUserName}"...`, 'info');
    const createUserResult = await CommandRunner.exec(
      `aws iam create-user --user-name ${cfg.iamUserName}`,
      { ignoreError: true }
    );
    if (createUserResult.exitCode && !/EntityAlreadyExists/i.test(createUserResult.stderr || '')) {
      throw new Error(
        `agentcore setup: IAM user creation failed: ${createUserResult.stderr?.trim()}`
      );
    }

    // Create managed policies and attach. Managed policies cap at 6144 chars, so the
    // bedrock-agentcore policy is split into two parts.
    this.log('Attaching IAM policies...', 'info');
    const ts = Date.now();
    const generalPolicyFile = path.join(tmpdir(), `ar-general-policy-${ts}.json`);
    const agentcorePolicy1File = path.join(tmpdir(), `ar-agentcore-policy-1-${ts}.json`);
    const agentcorePolicy2File = path.join(tmpdir(), `ar-agentcore-policy-2-${ts}.json`);
    try {
      await writeFile(generalPolicyFile, JSON.stringify(GENERAL_ACCESS_POLICY), 'utf8');
      await writeFile(agentcorePolicy1File, JSON.stringify(BEDROCK_AGENTCORE_POLICY_1), 'utf8');
      await writeFile(agentcorePolicy2File, JSON.stringify(BEDROCK_AGENTCORE_POLICY_2), 'utf8');
      for (const [suffix, policyFile] of [
        ['general-access', generalPolicyFile],
        ['bedrock-agentcore-1', agentcorePolicy1File],
        ['bedrock-agentcore-2', agentcorePolicy2File],
      ]) {
        const policyName = `${cfg.iamUserName}-${suffix}`;
        const policyArn = `arn:aws:iam::${accountId}:policy/${policyName}`;
        const createResult = await CommandRunner.exec(
          `aws iam create-policy --policy-name ${policyName} --policy-document file://${policyFile}`,
          { ignoreError: true }
        );
        if (createResult.exitCode) {
          if (!/EntityAlreadyExists/i.test(createResult.stderr || '')) {
            throw new Error(
              `agentcore setup: failed to create IAM policy "${policyName}": ${createResult.stderr?.trim()}`
            );
          }
          // Policy exists: create a new version (max 5; prune oldest non-default first)
          const listVersionsResult = await CommandRunner.exec(
            `aws iam list-policy-versions --policy-arn ${policyArn} --output json`,
            { ignoreError: true }
          );
          if (!listVersionsResult.exitCode) {
            const versions =
              JSON.parse(listVersionsResult.stdout || '{"Versions":[]}').Versions || [];
            const nonDefault = versions.filter(v => !v.IsDefaultVersion);
            if (nonDefault.length >= 4) {
              // Delete oldest non-default to free a slot
              const oldest = nonDefault.sort(
                (a, b) => new Date(a.CreateDate) - new Date(b.CreateDate)
              )[0];
              await CommandRunner.exec(
                `aws iam delete-policy-version --policy-arn ${policyArn} --version-id ${oldest.VersionId}`,
                { ignoreError: true }
              );
            }
          }
          await CommandRunner.exec(
            `aws iam create-policy-version --policy-arn ${policyArn} --policy-document file://${policyFile} --set-as-default`
          );
          this.log(`IAM policy "${policyName}" updated to new version`, 'info');
        }
        await CommandRunner.exec(
          `aws iam attach-user-policy --user-name ${cfg.iamUserName} --policy-arn ${policyArn}`
        );
      }
    } finally {
      await unlink(generalPolicyFile).catch(() => {});
      await unlink(agentcorePolicy1File).catch(() => {});
      await unlink(agentcorePolicy2File).catch(() => {});
    }

    // ── 3. IAM access key → helm upgrade with credentials ─────────────────
    this.log('Creating IAM access key...', 'info');
    // Delete any existing keys first (max 2 per user)
    const listKeysResult = await CommandRunner.exec(
      `aws iam list-access-keys --user-name ${cfg.iamUserName} --output json`
    );
    const existingKeys = JSON.parse(listKeysResult.stdout || '{"AccessKeyMetadata":[]}');
    for (const key of existingKeys.AccessKeyMetadata) {
      await CommandRunner.exec(
        `aws iam delete-access-key --user-name ${cfg.iamUserName} --access-key-id ${key.AccessKeyId}`
      );
    }
    const createKeyResult = await CommandRunner.exec(
      `aws iam create-access-key --user-name ${cfg.iamUserName} --output json`
    );
    const keyData = JSON.parse(createKeyResult.stdout);
    const accessKeyId = keyData.AccessKey.AccessKeyId;
    const secretAccessKey = keyData.AccessKey.SecretAccessKey;
    this.log(`IAM access key created: ${accessKeyId}`, 'info');

    // Helm upgrade injects AWS credentials so agentregistry can call BedrockAgentCore APIs
    this.log('Updating agentregistry with AWS credentials...', 'info');
    const helmCredsArgs = [
      'upgrade',
      '-i',
      HELM_RELEASE,
      this.chartOci,
      '-n',
      this.namespace,
      '--create-namespace',
      '--version',
      this.version,
      '--wait',
      '--timeout',
      '10m',
      '--values',
      path.join(CONFIG_DIR, 'values.yaml'),
      ...(this.enterprise
        ? [
            '--set',
            'licensing.createSecret=true',
            '--set-string',
            `licensing.licenseKey=${process.env.ENTERPRISE_AGENTREGISTRY_LICENSE}`,
          ]
        : []),
      '--set',
      'aws.enabled=true',
      '--set-string',
      `aws.accessKeyId=${accessKeyId}`,
      '--set-string',
      `aws.secretAccessKey=${secretAccessKey}`,
      ...helmCtxArgs,
    ];
    if (region) helmCredsArgs.push('--set', `aws.region=${region}`);
    if (this.oidcIssuer) {
      helmCredsArgs.push(
        '--set',
        `oidc.issuer=${this.oidcIssuer}`,
        '--set',
        `oidc.clientId=${this.oidcClientId}`,
        '--set',
        `oidc.publicClientId=${this.oidcPublicClientId}`,
        '--set',
        `oidc.roleClaim=${this.oidcRoleClaim}`,
        '--set',
        `oidc.superuserRole=${this.oidcSuperuserRole}`
      );
      if (this.oidcClientSecret) {
        helmCredsArgs.push('--set-string', `oidc.clientSecret=${this.oidcClientSecret}`);
      }
    }
    if (this.kagentOutboundOidcClientId) {
      if (this.kagentOutboundOidcIssuer) {
        helmCredsArgs.push(
          '--set',
          `kagent.outboundAuth.oidc.issuer=${this.kagentOutboundOidcIssuer}`
        );
      }
      helmCredsArgs.push(
        '--set',
        `kagent.outboundAuth.oidc.clientId=${this.kagentOutboundOidcClientId}`
      );
      if (this.kagentOutboundOidcClientSecret) {
        helmCredsArgs.push(
          '--set-string',
          `kagent.outboundAuth.oidc.clientSecret=${this.kagentOutboundOidcClientSecret}`
        );
      }
    }
    await KubernetesHelper.helm(helmCredsArgs, { spinner: this.spinner });

    // ── 4. arctl runtime setup → CloudFormation YAML ──────────────────────
    this.log('Generating AgentCore CloudFormation template via arctl...', 'info');
    const registryUrl = `https://${this.hostname}`;

    await ArctlHelper.resolve({ version: cfg.arctlVersion });

    // ── 4. CloudFormation stack: create if missing, read outputs if exists ─
    // arctl generates a fresh ExternalId each run, so the template only helps first-time
    // creation. On later runs, read stack outputs for the ExternalId matching the live
    // role trust policy.
    let roleArn;
    let externalId;

    this.log(`Checking CloudFormation stack "${cfg.stackName}"...`, 'info');
    const describeResult = await CommandRunner.exec(
      `aws cloudformation describe-stacks --stack-name ${cfg.stackName} ${regionFlag} --output json`,
      { ignoreError: true }
    );

    if (describeResult.exitCode) {
      // Stack does not exist → generate template and create it
      this.log(`Stack not found — running arctl runtime setup to generate CFN template...`, 'info');

      const spinnerText = this.spinner?.text;
      this.spinner?.stop();
      let cfnYaml;
      try {
        cfnYaml = await ArctlHelper.deviceLoginAndExec(
          ['runtime', 'setup', 'bedrock-agent-core', '--aws-account-id', accountId],
          {
            registryUrl,
            oidcIssuerUrl: this.oidcIssuer,
            oidcClientId: cfg.arctlClientId,
            version: cfg.arctlVersion,
          }
        );
      } finally {
        if (this.spinner && spinnerText) this.spinner.start(spinnerText);
      }

      if (!cfnYaml?.trim()) {
        throw new Error('agentcore setup: arctl runtime setup returned empty output');
      }

      // Save CFN YAML to ._output/ for inspection
      const outputDir = path.join(process.cwd(), '._output');
      const cfnDumpPath = path.join(outputDir, 'agentcore-cfn.yaml');
      try {
        const { mkdir } = await import('fs/promises');
        await mkdir(outputDir, { recursive: true });
        await writeFile(cfnDumpPath, cfnYaml, 'utf8');
        this.log(`CFN YAML saved to ${cfnDumpPath}`, 'info');
      } catch (dumpErr) {
        this.log(`Could not save CFN YAML: ${dumpErr.message}`, 'warn');
      }

      const cfnFile = path.join(tmpdir(), `agentcore-cfn-${Date.now()}.yaml`);
      try {
        await writeFile(cfnFile, cfnYaml, 'utf8');
        this.log(`Deploying CloudFormation stack "${cfg.stackName}"...`, 'info');
        await CommandRunner.exec(
          `aws cloudformation create-stack --stack-name ${cfg.stackName} --template-body file://${cfnFile} --capabilities CAPABILITY_NAMED_IAM ${regionFlag}`
        );
        this.log(
          'Waiting for CloudFormation stack to complete (may take a few minutes)...',
          'info'
        );
        await CommandRunner.exec(
          `aws cloudformation wait stack-create-complete --stack-name ${cfg.stackName} ${regionFlag}`,
          { timeout: 600_000 }
        );
        this.log(`CloudFormation stack "${cfg.stackName}" created`, 'success');
      } finally {
        await unlink(cfnFile).catch(() => {});
      }
    } else {
      const stackInfo = JSON.parse(describeResult.stdout);
      const status = stackInfo.Stacks?.[0]?.StackStatus;
      this.log(
        `CloudFormation stack "${cfg.stackName}" already exists (${status}) — reading outputs`,
        'info'
      );
      if (status !== 'CREATE_COMPLETE' && status !== 'UPDATE_COMPLETE') {
        this.log(`Stack status: ${status} — waiting...`, 'info');
        await CommandRunner.exec(
          `aws cloudformation wait stack-create-complete --stack-name ${cfg.stackName} ${regionFlag}`,
          { timeout: 600_000 }
        );
      }
      // Save deployed template to ._output/ so agentcore-cfn.yaml reflects the live stack
      try {
        const templateResult = await CommandRunner.exec(
          `aws cloudformation get-template --stack-name ${cfg.stackName} ${regionFlag} --output json`,
          { ignoreError: true }
        );
        if (!templateResult.exitCode) {
          const templateBody = JSON.parse(templateResult.stdout || '{}').TemplateBody || '';
          if (templateBody) {
            const { mkdir } = await import('fs/promises');
            const outputDir = path.join(process.cwd(), '._output');
            await mkdir(outputDir, { recursive: true });
            await writeFile(path.join(outputDir, 'agentcore-cfn.yaml'), templateBody, 'utf8');
          }
        }
      } catch {
        /* best-effort */
      }
    }

    // Read stack outputs: the source of truth for RoleArn and ExternalId
    const outputResult = await CommandRunner.exec(
      `aws cloudformation describe-stacks --stack-name ${cfg.stackName} ${regionFlag} --output json`
    );
    const stackOutputs = JSON.parse(outputResult.stdout || '{}')?.Stacks?.[0]?.Outputs || [];
    roleArn = stackOutputs.find(o => o.OutputKey === 'RoleArn')?.OutputValue?.trim();
    if (!roleArn)
      throw new Error(`agentcore setup: RoleArn not found in stack "${cfg.stackName}" outputs`);
    this.log(`AgentCore RoleArn: ${roleArn}`, 'info');
    externalId = stackOutputs.find(o => o.OutputKey === 'ExternalId')?.OutputValue?.trim() || null;
    if (!externalId)
      throw new Error(`agentcore setup: ExternalId not found in stack "${cfg.stackName}" outputs`);
    this.log(`AgentCore ExternalId: ${externalId}`, 'info');

    // ── 6. arctl apply Runtime (BedrockAgentCore) ─────────────────────────
    this.log(
      `Registering BedrockAgentCore runtime "${cfg.runtimeName}" in agentregistry...`,
      'info'
    );
    const runtimeManifest = yaml.dump(
      {
        apiVersion: 'ar.dev/v1alpha1',
        kind: 'Runtime',
        metadata: { name: cfg.runtimeName },
        spec: {
          type: 'BedrockAgentCore',
          ...(cfg.telemetryEndpoint && { telemetryEndpoint: cfg.telemetryEndpoint }),
          config: {
            region,
            roleArn,
            externalId,
            ...(cfg.networkId && { networkId: cfg.networkId }),
            ...(cfg.privateSubnetId && { subnetId: cfg.privateSubnetId }),
            ...(cfg.securityGroupIds?.length && {
              agentCoreRuntimeSecurityGroupIds: cfg.securityGroupIds,
            }),
          },
        },
      },
      { lineWidth: -1, indent: 2 }
    );

    const runtimeFile = path.join(tmpdir(), `agentcore-runtime-${Date.now()}.yaml`);
    await writeFile(runtimeFile, runtimeManifest, 'utf8');

    const spinnerText2 = this.spinner?.text;
    this.spinner?.stop();
    try {
      await ArctlHelper.deviceLoginAndApplyFile(runtimeFile, {
        registryUrl,
        oidcIssuerUrl: this.oidcIssuer,
        oidcClientId: cfg.arctlClientId,
        version: cfg.arctlVersion,
      });
    } finally {
      if (this.spinner && spinnerText2) this.spinner.start(spinnerText2);
      await unlink(runtimeFile).catch(() => {});
    }

    this.log(`AgentCore runtime "${cfg.runtimeName}" registered`, 'success');
  }

  /**
   * Tear down AgentCore setup in reverse order:
   *  1. Delete arctl Runtime from agentregistry
   *  2. Delete CloudFormation stack (removes cross-account IAM role)
   *  3. Delete IAM access keys, inline policies, and user
   */
  async _cleanupAgentcore() {
    const cfg = this.agentcore;
    const region = cfg.region;
    const regionFlag = region ? `--region ${region}` : '';
    const registryUrl = `https://${this.hostname}`;

    // 1. Remove arctl Runtime
    try {
      const spinnerText = this.spinner?.text;
      this.spinner?.stop();
      try {
        await ArctlHelper.deviceLoginAndExec(['delete', 'runtime', cfg.runtimeName], {
          registryUrl,
          oidcIssuerUrl: this.oidcIssuer,
          oidcClientId: cfg.arctlClientId,
          version: cfg.arctlVersion,
        });
      } finally {
        if (this.spinner && spinnerText) this.spinner.start(spinnerText);
      }
      this.log(`AgentCore runtime "${cfg.runtimeName}" removed`, 'success');
    } catch (err) {
      this.log(`agentcore cleanup: runtime removal warning: ${err.message}`, 'warn');
    }

    // 2. Delete CloudFormation stack
    try {
      const describeResult = await CommandRunner.exec(
        `aws cloudformation describe-stacks --stack-name ${cfg.stackName} ${regionFlag} --output json`,
        { ignoreError: true }
      );
      if (!describeResult.exitCode) {
        this.log(`Deleting CloudFormation stack "${cfg.stackName}"...`, 'info');
        await CommandRunner.exec(
          `aws cloudformation delete-stack --stack-name ${cfg.stackName} ${regionFlag}`
        );
        await CommandRunner.exec(
          `aws cloudformation wait stack-delete-complete --stack-name ${cfg.stackName} ${regionFlag}`,
          { timeout: 600_000 }
        );
        this.log(`CloudFormation stack "${cfg.stackName}" deleted`, 'success');
      }
    } catch (err) {
      this.log(`agentcore cleanup: CloudFormation removal warning: ${err.message}`, 'warn');
    }

    // 3. Delete IAM user (keys → policies → user)
    try {
      // Delete access keys
      const listKeysResult = await CommandRunner.exec(
        `aws iam list-access-keys --user-name ${cfg.iamUserName} --output json`,
        { ignoreError: true }
      );
      if (!listKeysResult.exitCode) {
        const keys = JSON.parse(listKeysResult.stdout || '{"AccessKeyMetadata":[]}');
        for (const key of keys.AccessKeyMetadata) {
          await CommandRunner.exec(
            `aws iam delete-access-key --user-name ${cfg.iamUserName} --access-key-id ${key.AccessKeyId}`,
            { ignoreError: true }
          );
        }
      }
      // Detach and delete managed policies
      const accountIdResult = await CommandRunner.exec(
        'aws sts get-caller-identity --query Account --output text',
        { ignoreError: true }
      );
      const accountId = accountIdResult.stdout?.trim();
      if (accountId) {
        for (const suffix of ['general-access', 'bedrock-agentcore-1', 'bedrock-agentcore-2']) {
          const policyArn = `arn:aws:iam::${accountId}:policy/${cfg.iamUserName}-${suffix}`;
          await CommandRunner.exec(
            `aws iam detach-user-policy --user-name ${cfg.iamUserName} --policy-arn ${policyArn}`,
            { ignoreError: true }
          );
          await CommandRunner.exec(`aws iam delete-policy --policy-arn ${policyArn}`, {
            ignoreError: true,
          });
        }
      }
      // Delete inline policies too: older versions attached "general-access" inline
      // rather than managed, and IAM won't delete a user with any policy still attached.
      const listInlineResult = await CommandRunner.exec(
        `aws iam list-user-policies --user-name ${cfg.iamUserName} --output json`,
        { ignoreError: true }
      );
      if (!listInlineResult.exitCode) {
        const inlinePolicyNames = JSON.parse(
          listInlineResult.stdout || '{"PolicyNames":[]}'
        ).PolicyNames;
        for (const policyName of inlinePolicyNames) {
          await CommandRunner.exec(
            `aws iam delete-user-policy --user-name ${cfg.iamUserName} --policy-name ${policyName}`,
            { ignoreError: true }
          );
        }
      }
      // Delete user
      const deleteUserResult = await CommandRunner.exec(
        `aws iam delete-user --user-name ${cfg.iamUserName}`,
        { ignoreError: true }
      );
      if (deleteUserResult.exitCode && !/NoSuchEntity/i.test(deleteUserResult.stderr || '')) {
        throw new Error(deleteUserResult.stderr?.trim() || 'delete-user failed');
      }
      this.log(`IAM user "${cfg.iamUserName}" removed`, 'success');
    } catch (err) {
      this.log(`agentcore cleanup: IAM removal warning: ${err.message}`, 'warn');
    }
  }

  async cleanup() {
    const kubectlCtxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];

    // Running cleanup twice (e.g. repeated `clean -a`) is expected. If the namespace is
    // already gone, everything else (Gateway/DNS, AgentCore runtime registration, the
    // CloudFormation stack, the IAM user) went with it; retrying arctl's runtime
    // deregistration against a registry with no route would just fail on DNS for no reason.
    const nsCheck = await KubernetesHelper.kubectl(
      [...kubectlCtxArgs, 'get', 'namespace', this.namespace],
      { ignoreError: true }
    );
    if (nsCheck.exitCode !== 0) {
      this.log('agentregistry already removed, nothing to do', 'info');
      return;
    }

    this.log('Removing agentregistry');
    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];

    if (this.agentcore) {
      await this._cleanupAgentcore();
    }

    if (this.otelGateway) {
      await this._cleanupOtelGateway();
    }

    if (this.hostname && this.tlsEnabled) {
      await this.deleteResource(
        'Telemetry',
        'disable-mesh-tracing',
        this.namespace,
        this.kubeContext
      );
      await this.deleteResource('HTTPRoute', 'agentregistry-ui', this.namespace, this.kubeContext);
      await this.deleteResource(
        'Gateway',
        'agentregistry-ui-https',
        this.namespace,
        this.kubeContext
      );
      await this.deleteResource(
        'Certificate',
        'agentregistry-tls',
        this.namespace,
        this.kubeContext
      );
    }

    try {
      await KubernetesHelper.helm(
        ['uninstall', HELM_RELEASE, '-n', this.namespace, ...helmCtxArgs],
        { spinner: this.spinner }
      );
    } catch (err) {
      if (!/not found|no deployed releases/i.test(err.message)) throw err;
    }

    await KubernetesHelper.kubectl([
      ...kubectlCtxArgs,
      'delete',
      'namespace',
      this.namespace,
      '--ignore-not-found=true',
    ]);
    this.log('agentregistry removed', 'success');
  }
}
