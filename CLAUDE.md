# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Agentic AI demo framework, built on Istio Ambient Mesh. Node.js/Bun CLI (`src/cli.js`) that provisions cloud infrastructure across AWS, GCP, and Azure (Terraform), installs Solo Istio Ambient on Kubernetes clusters, and deploys/tests feature use cases.

## Commands

```bash
# Install dependencies
bun install

# Run CLI (Makefile uses bun)
bun run src/cli.js <command>

# Key Makefile targets (all delegate to CLI)
make infra-provision PROFILE=eks-single-cluster   # Provision cloud infra
make install-agentic INFRA=eks-single-cluster      # Install Istio Ambient
make verify-agentic                                # Verify installation
make list-usecases                                 # List use cases
make deploy-usecase USECASE=<name>                 # Deploy a use case
make infra-destroy PROFILE=<name>                  # Destroy infra
make all INFRA=<name>                              # Full provision + install

# Direct CLI usage
bun run src/cli.js base infra cloud list
bun run src/cli.js base infra cloud provision -p <name> [-y]
bun run src/cli.js base install --profile <name> --infra <name>
bun run src/cli.js usecase deploy -n <name>
bun run src/cli.js usecase clean -n <name>
bun run src/cli.js usecase test -n <name>
bun run src/cli.js app deploy -n <name>
bun run src/cli.js check-deps
```

## Required environment variables

```bash
export ENTERPRISE_ISTIO_LICENSE=<key>    # Required for install
export ISTIO_VERSION=1.28.5-solo       # Optional, set in profile

# keycloak addon (no defaults - deploy fails cleanly if unset)
export KEYCLOAK_ADMIN_USERNAME=<user>        # Keycloak master realm bootstrap admin username
export KEYCLOAK_ADMIN_PASSWORD=<password>    # Keycloak master realm bootstrap admin password
export KEYCLOAK_POSTGRES_USER=<user>         # Postgres superuser backing Keycloak's DB
export KEYCLOAK_POSTGRES_PASSWORD=<password> # Postgres superuser password
export SOLO_UI_DEFAULT_PASSWORD=<password>   # Required only when soloUIClients.enabled (solo-admin/solo-reader/solo-writer bootstrap password)
export GRAFANA_REALM_ADMIN_USERNAME=<user>   # Optional, only used when a 'grafana' realm is configured (default: 'grafana-admin')
export GRAFANA_REALM_ADMIN_PASSWORD=<password> # Required only when a 'grafana' realm is configured
export KAGENT_REALM_DEFAULT_PASSWORD=<password> # Required only when a 'kagent' realm is configured (kagent-admin/writer/reader bootstrap password)
export AGENTREGISTRY_REALM_DEFAULT_PASSWORD=<password> # Required only when an 'agentregistry' realm is configured
export RETAIL_RETURNS_CUSTOMER_PASSWORD=<password> # Required only when a 'retail-returns-customers' realm is configured
export CARRIER_PORTAL_REALM_DEFAULT_PASSWORD=<password> # Required only when a 'carrier-portal' realm is configured

# telemetry addon, full mode (no defaults - deploy fails cleanly if unset)
export GRAFANA_ADMIN_USERNAME=<user>         # Grafana admin login username
export GRAFANA_ADMIN_PASSWORD=<password>     # Grafana admin login password
```

## Style

- Don't soft-wrap `description` fields in usecase/feature/profile YAML — they don't render well on stdout.

## Architecture

### Four-layer config system

1. **Infra profiles** (`config/infra/*.yaml`) — cloud topology (provider, region, cluster count/roles). Kind: `InfraProfile`.
2. **Installation profiles** (`config/profiles/*.yaml`) — Istio version, mesh components, addons. Kind: `Profile`. References an infra profile via `spec.infra` and an environment via `spec.environment`.
3. **Environments** (`config/environments/*.yaml`) — domain names, DNS/TLS, per-cloud settings. Kind: `Environment`.
4. **Use case specs** (`config/usecases/**/*.yaml`) — sequences of features + apps to deploy for a demo scenario.

### Infra state

Provisioned infra state written to `._output/infra/<name>/state.yaml`. Kubeconfigs land in `._output/infra/<name>/kubeconfig/`. Env vars exported to `._output/infra/<name>/env.sh`.

### Feature system

`Feature` (base class in `src/lib/feature.js`) — subclasses implement `deploy()` and `cleanup()`. `AddonFeature` extends `Feature` and skips Ambient namespace labeling (for infra addons like cert-manager).

`FeatureManager` (static registry) — features and addons register by name at startup via `features/index.js` and `addons/index.js`. Use cases reference features by registered name.

### Feature categories

- **Traffic management** (`features/traffic-management/`): gateway, request-routing, traffic-shifting, header-routing, fault-injection, retry-policy, service-entry, destination-rule, ingress-httproute, agentgateway-backend
- **Security** (`features/security/`): waypoint, deny-all-policy, authorization-policy, egress-waypoint, egress-authorization, env-secret, namespace, oidc-gateway
- **Multicluster** (`features/multicluster/`): global-service, segment, global-alias
- **Observability** (`features/observability/`): ztunnel-metrics, istiod-metrics
- **Agentic** (`features/agentic/`): mcp-server, agentregistry-route, agentregistry-catalog, agentregistry-provider, agentregistry-agent, agentregistry-mcp-server, agentcore-gateway, providers, token-exchange-policy, agentgateway-a2a-route, mcp-tool-policy, mcp-codemode-route, budget-policy, pii-guardrail-policy, stage-policy-controller, mcp-elicitation-policy, entra-obo-policy, kagent-mcp-server, kagent-access-policy, access-policy-test-harness
- **Addons** (`addons/`): agentgateway, agentregistry, aws-load-balancer-controller, cert-manager, cilium, external-dns, kagent, keycloak, solo-ui, spire, telemetry

Cross-cluster trust setup (root/intermediate CA generation, east-west gateway, cluster linking) is not part of the Feature registry - it lives in `src/lib/multicluster.js` (`CertificateManager`, `SpireRootManager`, `EastWestGateway`, `ClusterLinker`, `PeeringInstaller`) and runs as part of `base install` for multicluster profiles.

Each feature directory contains `index.js` (the Feature subclass) and optionally `config/` (YAML templates applied to the cluster).

### Adding a new feature

1. Create `features/<category>/<feature-name>/index.js` extending `Feature` with `deploy()` and `cleanup()`.
2. Add static YAML templates to `features/<category>/<feature-name>/config/` if needed.
3. Register in `features/index.js` via `FeatureManager.register('<name>', FeatureClass)`.

### Keep runbooks in sync

Each addon's `runbook.js` sidecar (next to `index.js`) hand-reconstructs its install/cleanup commands rather than executing the real code, so it silently drifts if not updated alongside the addon. When adding or changing an addon or feature's install steps, add/update its `runbook.js`/`buildRunbook()` in the same change.

### Adding a new use case

Create `config/usecases/<single-cluster|multi-cluster>/<category>/<use-case-name>/spec.yaml` with:

```yaml
apiVersion: agentic.demo/v1
kind: UseCase
metadata:
  name: <display-name>
  description: <what this demonstrates>
spec:
  category: <category>
  requires:
    applications:
      - name: bookinfo # from extras/applications/
        namespace: bookinfo
  features:
    - name: <registered-feature-name>
      description: <what this step does>
      config: {}
  tests: []
```

### Applications

Reusable demo apps in `extras/applications/<name>/<name>.yaml` (multi-doc YAML). Deployed via `UseCaseManager.deployApplication()` which auto-labels the namespace for Ambient.

### Provisioner

`cloud-provisioner/terraform-cloud-provisioner` (git submodule) — Terraform wrapper. `src/lib/provisioner-runners/terraform-cloud.js` orchestrates it. Infra profile YAML drives Terraform variable generation.

### Current use case tracking

Tracked in a ConfigMap (`agentic-feature-catalog-current-usecase` in `default` namespace). Deploying a new use case auto-cleans the previous one.
