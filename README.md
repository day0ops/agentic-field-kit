# Agentic Field Kit

[![CI](https://img.shields.io/github/actions/workflow/status/day0ops/agentic-field-kit/ci.yml?branch=main&label=CI)](https://github.com/day0ops/agentic-field-kit/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/day0ops/agentic-field-kit)](LICENSE)

Provision, install, demo, and test agentic AI workloads on Istio Ambient Mesh. Node.js/Bun CLI for cloud infrastructure provisioning and Solo Istio Ambient installation on Kubernetes clusters. Supports single-cluster and multi-cluster topologies, use cases, and addon management.

It drives infrastructure across AWS, GCP, and Azure through the same set of commands, then layers Ambient features, agentic addons (agentgateway, agentregistry, kagent, SPIRE), and demo applications on top through a small YAML-based config system. Everything here (provisioning, installation, use case deployment) is scriptable, so a full environment can go from nothing to a working demo in one command.

![install.gif](images/install.gif)

## Prerequisites

Ensure you have the following installed:

- **Node.js** >= 24.14.0
- **[bun](https://bun.sh)** - JavaScript runtime and package manager
- **Docker Desktop** - for building and pushing images
- **kubectl** - Kubernetes CLI
- **helm** - Kubernetes package manager
- **[Terraform](https://www.terraform.io/) or [OpenTofu](https://opentofu.org/)** - for cloud cluster provisioning
- **jq** - JSON processor

## Install

```bash
bun install
```

To use the `agentic` command directly instead of `bun run src/cli.js`, link it globally:

```bash
bun link
```

## Quick Start

The fastest path from nothing to a running demo: provision cloud infrastructure and install Istio Ambient, using one of the built-in infra/profile pairs.

```bash
export ENTERPRISE_ISTIO_LICENSE=<your-license-key>
export AWS_PROFILE=<your-aws-profile>

# Provision infra + install Istio Ambient in one shot
make all INFRA=eks-single-cluster MESH_PROFILE=eks-single-cluster-mesh-with-spire

# or, step by step
agentic base infra cloud provision -p eks-single-cluster -y
agentic base install --profile eks-single-cluster-mesh-with-spire --infra eks-single-cluster
```

Every `agentic` command above has an equivalent `make` target, and `make all` wraps the provision + install sequence into a single call.

## Configuration

Four-layer config system:

```
config/
├── infra/          # Cloud topology — provider, region, cluster roles  (Kind: InfraProfile)
├── profiles/       # Ambient installation — Istio version, components, addons  (Kind: Profile)
├── environments/   # Domain names, DNS, TLS config  (Kind: Environment)
│   ├── aws-dev.yaml
│   └── local.yaml
└── usecases/       # Feature + app sequences for demo scenarios  (Kind: UseCase)
```

Profiles reference an infra profile via `spec.infra` and an environment via `spec.environment`. See [docs/reference.md](docs/reference.md) for the full list of built-in infra and installation profiles.

## Step-by-Step Workflow

### 1. Provision infrastructure

```bash
export AWS_PROFILE=<your-aws-profile>
agentic base infra cloud provision -p eks-single-cluster -y
# or
make infra-provision PROFILE=eks-single-cluster
```

### 2. Load environment

```bash
source $(agentic base infra cloud env -p eks-single-cluster)
# or
make load-env PROFILE=eks-single-cluster
```

### 3. Install Istio Ambient

```bash
export ENTERPRISE_ISTIO_LICENSE=<key>

agentic base install --profile eks-single-cluster-mesh-with-spire --infra eks-single-cluster
# or
make install-agentic INFRA=eks-single-cluster MESH_PROFILE=eks-single-cluster-mesh-with-spire
```

### 4. Verify Ambient installation

```bash
agentic base verify
# or
make verify-agentic
```

### 5. Deploy a use case

```bash
agentic usecase deploy --name single-cluster/traffic-management/canary-deployment
# or
make deploy-usecase USECASE=single-cluster/traffic-management/canary-deployment
```

### 6. Clean up

```bash
# Uninstall Istio Ambient and profile-based addons
agentic base clean --infra eks-single-cluster -a
# or
make uninstall-agentic-with-addons INFRA=eks-single-cluster

# Destroy provisioned infrastructure
agentic base infra cloud destroy -p eks-single-cluster -y
# or
make infra-destroy PROFILE=eks-single-cluster
```

## More

See [docs/reference.md](docs/reference.md) for the full CLI reference, Makefile targets, built-in infra/installation profiles, environment variables, project structure, and troubleshooting tips.
