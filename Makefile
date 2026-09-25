.PHONY: help infra-provision infra-destroy infra-status infra-list infra-env install-agentic uninstall-agentic verify-agentic clean clean-addons all check-env list-usecases deploy-usecase test-usecase load-env kubeconfig

# Default target
.DEFAULT_GOAL := help

# Colors for output
BLUE := \033[0;34m
GREEN := \033[0;32m
YELLOW := \033[0;33m
RED := \033[0;31m
NC := \033[0m # No Color

# CLI runner (bun or node)
CLI := bun run src/cli.js

# Profile (set via PROFILE=name on the command line)
# When not set, interactive targets will prompt for selection
PROFILE ?=

# Environment variables that can be overridden
ENTERPRISE_ISTIO_LICENSE ?= $(shell if [ -n "$$ENTERPRISE_ISTIO_LICENSE" ]; then echo "$$ENTERPRISE_ISTIO_LICENSE"; fi)
SOLO_ISTIO_REPO_KEY ?= $(shell if [ -n "$$SOLO_ISTIO_REPO_KEY" ]; then echo "$$SOLO_ISTIO_REPO_KEY"; fi)
KUBE_CONTEXT ?= $(shell if [ -n "$$KUBE_CONTEXT" ]; then echo "$$KUBE_CONTEXT"; fi)
ISTIO_VERSION ?= 1.28.2
ISTIO_IMAGE ?= $(ISTIO_VERSION)-solo

##@ General

help: ## Display this help message
	@echo "$(BLUE)Available targets:$(NC)"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(GREEN)%-20s$(NC) %s\n", $$1, $$2}'
	@echo ""
	@echo "$(YELLOW)Environment Variables:$(NC)"
	@echo "  ENTERPRISE_ISTIO_LICENSE - Required for installation"
	@echo "  SOLO_ISTIO_REPO_KEY   - Required for installation (image repo key)"
	@echo "  PROFILE             - Infra/installation profile name (interactive if not set)"
	@echo "  KUBE_CONTEXT        - Kubernetes context to use (optional, overrides PROFILE)"
	@echo "  ISTIO_VERSION       - Istio version (default: $(ISTIO_VERSION))"
	@echo "  ISTIO_IMAGE         - Istio image tag (default: $(ISTIO_IMAGE))"
	@echo ""

check-env:
	@if [ -z "$(ENTERPRISE_ISTIO_LICENSE)" ]; then \
		echo "$(YELLOW)Warning: ENTERPRISE_ISTIO_LICENSE is not set$(NC)"; \
		echo "  Set it with: export ENTERPRISE_ISTIO_LICENSE=<your-key>"; \
		exit 1; \
	fi
	@if [ -z "$(SOLO_ISTIO_REPO_KEY)" ]; then \
		echo "$(YELLOW)Warning: SOLO_ISTIO_REPO_KEY is not set$(NC)"; \
		echo "  Set it with: export SOLO_ISTIO_REPO_KEY=<your-key>"; \
		exit 1; \
	fi
	@command -v kubectl >/dev/null 2>&1 || { echo "$(RED)Error: kubectl is not installed$(NC)"; exit 1; }
	@command -v helm >/dev/null 2>&1 || { echo "$(RED)Error: helm is not installed$(NC)"; exit 1; }
	@command -v terraform >/dev/null 2>&1 || { echo "$(YELLOW)Warning: terraform is not installed (needed for infra-provision)$(NC)"; }

##@ Infrastructure

infra-list: ## List available infra profiles
	@$(CLI) base infra cloud list

infra-provision: ## Provision infrastructure (interactive, or PROFILE=name to skip prompt)
	@if [ -n "$(PROFILE)" ]; then \
		$(CLI) base infra cloud provision -p $(PROFILE) -y; \
	else \
		$(CLI) base infra cloud provision; \
	fi

infra-destroy: ## Destroy infrastructure (interactive, or PROFILE=name to skip prompt)
	@if [ -n "$(PROFILE)" ]; then \
		$(CLI) base infra cloud destroy -p $(PROFILE) -y; \
	else \
		$(CLI) base infra cloud destroy; \
	fi

infra-status: ## Show infrastructure provisioning status (interactive, or PROFILE=name)
	@if [ -n "$(PROFILE)" ]; then \
		$(CLI) base infra cloud status -p $(PROFILE); \
	else \
		$(CLI) base infra cloud status; \
	fi

infra-env: ## Print path to env.sh (interactive, or PROFILE=name)
	@if [ -n "$(PROFILE)" ]; then \
		$(CLI) base infra cloud env -p $(PROFILE); \
	else \
		$(CLI) base infra cloud env; \
	fi

##@ Agentic Installation

install-agentic: check-env ## Install Istio Ambient (auto-detects provisioned infra, or INFRA=name / KUBE_CONTEXT=ctx)
	@ENTERPRISE_ISTIO_LICENSE=$(ENTERPRISE_ISTIO_LICENSE) \
	SOLO_ISTIO_REPO_KEY=$(SOLO_ISTIO_REPO_KEY) \
	$(CLI) base install \
		$(if $(MESH_PROFILE),--profile $(MESH_PROFILE)) \
		$(if $(INFRA),--infra $(INFRA)) \
		$(if $(KUBE_CONTEXT),--context $(KUBE_CONTEXT))

uninstall-agentic: ## Uninstall Istio Ambient (auto-detects infra, or INFRA=name / KUBE_CONTEXT=ctx)
	@$(CLI) base clean \
		$(if $(MESH_PROFILE),--profile $(MESH_PROFILE)) \
		$(if $(INFRA),--infra $(INFRA)) \
		$(if $(KUBE_CONTEXT),--context $(KUBE_CONTEXT))

uninstall-agentic-with-addons: ## Uninstall Istio Ambient and all addons
	@$(CLI) base clean -a \
		$(if $(MESH_PROFILE),--profile $(MESH_PROFILE)) \
		$(if $(INFRA),--infra $(INFRA)) \
		$(if $(KUBE_CONTEXT),--context $(KUBE_CONTEXT))

clean-addons: ## Clean up all profile-based addons (cert-manager, external-dns, keycloak, solo-ui, cilium)
	@$(CLI) base clean-addons

verify-agentic: ## Verify Ambient installation on current context
	@$(CLI) base verify

##@ Complete Workflows

all: ## Complete setup: provision + install Ambient (requires INFRA=name, optional MESH_PROFILE=default)
	@if [ -z "$(INFRA)" ]; then \
		echo "$(RED)Error: INFRA is required for 'all'. Usage: make all INFRA=production MESH_PROFILE=default$(NC)"; \
		exit 1; \
	fi
	@echo "$(BLUE)=== Complete Setup for infra: $(INFRA) ===$(NC)"
	@$(MAKE) infra-provision PROFILE=$(INFRA)
	@echo ""
	@echo "$(BLUE)Waiting for clusters to be ready...$(NC)"
	@sleep 10
	@$(MAKE) install-agentic INFRA=$(INFRA) MESH_PROFILE=$(or $(MESH_PROFILE),default)
	@echo ""
	@echo "$(GREEN)✓ Complete setup finished!$(NC)"

clean: ## Destroy infrastructure (requires PROFILE=name)
	@if [ -z "$(PROFILE)" ]; then \
		echo "$(RED)Error: PROFILE is required for 'clean'. Usage: make clean PROFILE=production$(NC)"; \
		exit 1; \
	fi
	@echo "$(YELLOW)Cleaning up profile: $(PROFILE)...$(NC)"
	@$(MAKE) infra-destroy PROFILE=$(PROFILE)
	@echo "$(GREEN)✓ Cleanup complete$(NC)"

##@ Feature Catalog

list-usecases: ## List available use cases
	@$(CLI) usecase list

deploy-usecase: ## Deploy a use case (USECASE=name, APP=name, FEATURE=name)
	@if [ -z "$(USECASE)" ]; then \
		$(CLI) usecase deploy; \
	else \
		if [ -n "$(APP)" ] && [ -n "$(FEATURE)" ]; then \
			$(CLI) usecase deploy --name $(USECASE) --app $(APP) --feature $(FEATURE); \
		elif [ -n "$(APP)" ]; then \
			$(CLI) usecase deploy --name $(USECASE) --app $(APP); \
		else \
			$(CLI) usecase deploy --name $(USECASE); \
		fi; \
	fi

test-usecase: ## Test a deployed use case (USECASE=name)
	@if [ -z "$(USECASE)" ]; then \
		echo "$(YELLOW)Note: Tests run automatically during deployment.$(NC)"; \
		echo "$(YELLOW)Re-deploying use case to run tests (interactive)...$(NC)"; \
		$(CLI) usecase deploy; \
	else \
		echo "$(YELLOW)Note: Tests run automatically during deployment.$(NC)"; \
		echo "$(YELLOW)Re-deploying use case $(USECASE) to run tests...$(NC)"; \
		$(CLI) usecase deploy --name $(USECASE); \
	fi

##@ Utilities

load-env: ## Show env.sh path for sourcing (interactive, or PROFILE=name)
	@if [ -n "$(PROFILE)" ]; then \
		echo "$(BLUE)To load the environment:$(NC)"; \
		echo "  source $$($(CLI) base infra cloud env -p $(PROFILE))"; \
	else \
		$(CLI) base infra cloud env; \
	fi

kubeconfig: ## Print environment variables including kubeconfig paths (interactive, or PROFILE=name)
	@if [ -n "$(PROFILE)" ]; then \
		$(CLI) base infra cloud env -p $(PROFILE) --print; \
	else \
		$(CLI) base infra cloud env --print; \
	fi
