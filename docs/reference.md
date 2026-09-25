# Reference

Full reference for the `agentic` CLI, Makefile targets, built-in profiles, environment variables, project structure, and common troubleshooting steps. See the [README](../README.md) for prerequisites, installation, and the quick start.

## Infra Profiles

| Profile                   | Provider        | Clusters                               |
| ------------------------- | --------------- | -------------------------------------- |
| `eks-single-cluster`      | EKS             | 1                                      |
| `eks-single-cluster-ipv6` | EKS IPv6        | 1                                      |
| `eks-multi-cluster`       | EKS             | 2 (east, west)                         |
| `eks-multi-cluster-ipv6`  | EKS IPv6        | 2 (east, west)                         |
| `gke-single-cluster`      | GKE             | 1                                      |
| `gke-multi-cluster`       | GKE             | 2 (east, west)                         |
| `aks-single-cluster`      | AKS             | 1                                      |
| `aks-multi-cluster`       | AKS             | 2 (east, west)                         |
| `hybrid-multi-cloud`      | EKS + GKE + AKS | 3 (mgmt on EKS, workload on GKE + AKS) |

![](../images/infra.gif)

## Installation Profiles

| Profile                                                           | Description                                                                                                            |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `eks-single-cluster-mesh-with-spire`                              | Single-cluster ambient mesh with SPIRE workload identity attestation                                                   |
| `eks-multi-cluster-auto-peering-operator`                         | Multicluster ambient mesh, helm-based peering, installed via the Solo operator, agentgateway ingress                   |
| `eks-multi-cluster-agentgateway-hub-spoke`                        | Multicluster ambient mesh (helm peering) with enterprise agentgateway in a hub-spoke configuration                     |
| `eks-multi-cluster-agentgateway-hub-spoke-spire-distinct-root-ca` | Hub-spoke agentgateway profile for testing SPIRE distinct root CAs (independent, uncrossed roots per cluster)          |
| `eks-multi-cluster-agentgateway-hub-spoke-spire-multi-root-ca`    | Hub-spoke agentgateway profile for testing SPIRE multi root CA (independent root federated with istiod's cacerts root) |
| `eks-multi-cluster-agentic-stack-simple`                          | Full agentic stack (agentgateway hub, agentregistry, kagent) over multicluster ambient mesh                            |
| `eks-multi-cluster-agentic-stack-kagent-runtime-spire`            | Agentic stack with agents on the in-cluster kagent runtime, agentregistry integration, SPIRE identity                  |
| `eks-multi-cluster-peering-with-agentic-hub-spoke-spire`          | Agentic stack with agents on Bedrock AgentCore runtime, agentregistry integration, SPIRE identity                      |

## Environment Variables

| Variable                                | Required                                               | Description                                                 |
| --------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| `ENTERPRISE_ISTIO_LICENSE`              | Yes (install)                                          | Solo Istio enterprise license key                           |
| `AWS_PROFILE`                           | Yes (EKS)                                              | AWS SSO profile name                                        |
| `KEYCLOAK_ADMIN_USERNAME`               | Yes (keycloak addon)                                   | Keycloak master realm bootstrap admin username              |
| `KEYCLOAK_ADMIN_PASSWORD`               | Yes (keycloak addon)                                   | Keycloak master realm bootstrap admin password              |
| `KEYCLOAK_POSTGRES_USER`                | Yes (keycloak addon)                                   | Postgres superuser backing Keycloak's DB                    |
| `KEYCLOAK_POSTGRES_PASSWORD`            | Yes (keycloak addon)                                   | Postgres superuser password                                 |
| `SOLO_UI_DEFAULT_PASSWORD`              | Yes (soloUIClients)                                    | solo-admin/solo-reader/solo-writer bootstrap password       |
| `GRAFANA_REALM_ADMIN_USERNAME`          | No (default: grafana-admin)                            | Grafana OIDC demo admin username (keycloak 'grafana' realm) |
| `GRAFANA_REALM_ADMIN_PASSWORD`          | Yes (when 'grafana' realm configured)                  | Grafana OIDC demo admin password                            |
| `KAGENT_REALM_DEFAULT_PASSWORD`         | Yes (when 'kagent' realm configured)                   | kagent-admin/writer/reader bootstrap password               |
| `AGENTREGISTRY_REALM_DEFAULT_PASSWORD`  | Yes (when 'agentregistry' realm configured)            | agentregistry demo user bootstrap password                  |
| `RETAIL_RETURNS_CUSTOMER_PASSWORD`      | Yes (when 'retail-returns-customers' realm configured) | retail-returns-customers demo user bootstrap password       |
| `CARRIER_PORTAL_REALM_DEFAULT_PASSWORD` | Yes (when 'carrier-portal' realm configured)           | carrier-portal demo user bootstrap password                 |
| `GRAFANA_ADMIN_USERNAME`                | Yes (telemetry addon, full mode)                       | Grafana admin login username                                |
| `GRAFANA_ADMIN_PASSWORD`                | Yes (telemetry addon, full mode)                       | Grafana admin login password                                |

## Project Structure

```
.
├── src/
│   ├── cli.js                  # CLI entry point
│   └── lib/                    # Core libraries
│       ├── installer.js        # Ambient installation logic
│       ├── infra-manager.js    # Cloud infra orchestration
│       ├── infra-state.js      # Provisioned state management
│       ├── environment.js      # Environment resolution + templating
│       ├── feature.js          # Feature/addon base classes + registry
│       ├── multicluster.js     # Cross-cluster trust, east-west gateway, cluster linking
│       └── usecase.js          # Use case deployment
├── features/                   # Feature implementations
│   ├── traffic-management/
│   ├── security/
│   ├── multicluster/
│   ├── observability/
│   └── agentic/
├── addons/                     # Addon implementations
│   ├── agentgateway/
│   ├── agentregistry/
│   ├── aws-load-balancer-controller/
│   ├── cert-manager/
│   ├── cilium/
│   ├── external-dns/
│   ├── kagent/
│   ├── keycloak/
│   ├── solo-ui/
│   ├── spire/
│   └── telemetry/
├── config/
│   ├── infra/                  # InfraProfile YAMLs
│   ├── profiles/               # Installation Profile YAMLs
│   ├── environments/           # Environment YAMLs
│   └── usecases/               # UseCase specs
├── extras/
│   └── applications/           # Reusable demo apps (bookinfo, httpbin, finflow, retail-returns, sre-incident-response, ...)
└── cloud-provisioner/          # Terraform provisioner (git submodule)
```

## CLI Reference

Invoke via `bun run src/cli.js` (or `agentic` if installed globally). Commands follow the `agentic <group> <subcommand>` pattern.

### Utilities

```bash
agentic version [-s|--short]   # Display banner, version, and description
agentic check-deps             # Check if required dependencies are installed
```

### Base — Manage base infrastructure

```bash
# Install Istio Ambient mesh on clusters
agentic base install [--profile <name>] [--infra <name>] [--context <ctx...>]
#   --profile  Installation profile (from config/profiles/)
#   --infra    Infra profile name (resolves cluster contexts from provisioned state)
#   --context  Explicit kube context(s) for pre-existing clusters

# Verify Istio Ambient installation
agentic base verify [-c|--context <context>]

# Uninstall Istio Ambient from cluster(s)
agentic base clean [--profile <name>] [--infra <name>] [--context <ctx...>] [-a|--addons]
#   -a, --addons  Also clean up all profile-based addons

# Clean up all profile-based addons
agentic base clean-addons
```

### Cloud infrastructure — Manage cloud infrastructure (EKS, GKE, AKS)

```bash
agentic base infra cloud list                              # List available infra profiles
agentic base infra cloud provision [-p|--profile <name>] [-y|--yes]
agentic base infra cloud destroy   [-p|--profile <name>] [-y|--yes]
agentic base infra cloud status    [-p|--profile <name>]   # Show infrastructure provisioning status
agentic base infra cloud env       [-p|--profile <name>] [--print]
#   --print  Print env.sh contents to stdout instead of the path
```

### Use cases — Manage use cases

```bash
agentic usecase list
agentic usecase deploy [-n|--name <name>]
agentic usecase clean  [-n|--name <name>] [-c|--current]
agentic usecase test   [-n|--name <name>]
```

`-c` / `--current` on `clean`: remove the use case tracked as currently deployed (ConfigMap `agentic-feature-catalog-current-usecase`). Omit `--name` when using this flag.

### Applications — Manage applications

```bash
agentic app list
agentic app deploy [-n|--name <name>] [--namespace <ns>]
```

### Installation profiles — Manage installation profiles

```bash
agentic profile list                      # List available installation profiles
agentic profile show [-n|--name <name>]   # Show details of an installation profile
```

## Makefile Targets

### Infrastructure

| Target                                | Description                                    |
| ------------------------------------- | ---------------------------------------------- |
| `make infra-list`                     | List available infra profiles                  |
| `make infra-provision [PROFILE=name]` | Provision infrastructure from an infra profile |
| `make infra-destroy [PROFILE=name]`   | Destroy provisioned infrastructure             |
| `make infra-status [PROFILE=name]`    | Show infrastructure provisioning status        |
| `make infra-env [PROFILE=name]`       | Print path to env.sh                           |

### Agentic installation

| Target                                                  | Description                                          |
| ------------------------------------------------------- | ---------------------------------------------------- |
| `make install-agentic [INFRA=name] [MESH_PROFILE=name]` | Install Istio Ambient mesh on clusters               |
| `make uninstall-agentic [INFRA=name]`                   | Uninstall Istio Ambient from cluster(s)              |
| `make uninstall-agentic-with-addons [INFRA=name]`       | Uninstall Istio Ambient and all profile-based addons |
| `make clean-addons`                                     | Clean up all profile-based addons                    |
| `make verify-agentic`                                   | Verify Istio Ambient installation                    |

### Workflows

| Target                                    | Description                                           |
| ----------------------------------------- | ----------------------------------------------------- |
| `make all INFRA=name [MESH_PROFILE=name]` | Provision infrastructure + install Istio Ambient mesh |
| `make clean PROFILE=name`                 | Destroy provisioned infrastructure                    |

### Use cases

| Target                               | Description              |
| ------------------------------------ | ------------------------ |
| `make list-usecases`                 | List available use cases |
| `make deploy-usecase [USECASE=name]` | Deploy a use case        |
| `make test-usecase [USECASE=name]`   | Test a deployed use case |

### Utilities

| Target                           | Description                                  |
| -------------------------------- | -------------------------------------------- |
| `make load-env [PROFILE=name]`   | Show command to source env.sh                |
| `make kubeconfig [PROFILE=name]` | Print env.sh contents (kubeconfig paths)     |
| `make check-env`                 | Validate required tools and license env vars |
| `agentic check-deps`             | Check if required dependencies are installed |

## Troubleshooting

**AWS credentials error during provision**

```bash
# Re-authenticate SSO
aws sso login --profile <your-profile>
export AWS_PROFILE=<your-profile>
```

**Check all dependencies**

```bash
agentic check-deps
```

**View infra state**

```bash
make infra-status PROFILE=<name>
```
