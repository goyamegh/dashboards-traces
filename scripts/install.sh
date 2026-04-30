#!/usr/bin/env bash
# Copyright OpenSearch Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Agent Health — One-line installer for the Docker observability stack.
# Usage: curl -fsSL https://raw.githubusercontent.com/opensearch-project/agent-health/main/scripts/install.sh | bash

set -euo pipefail

REPO_URL="https://github.com/opensearch-project/agent-health.git"
REPO_DIR="agent-health"
OPENSEARCH_PASSWORD="My_password_123!@#"

# --- Helpers ---
info()  { printf '\033[1;34m→\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# --- Prerequisite checks ---
info "Checking prerequisites..."

command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Install Docker Desktop from https://www.docker.com/products/docker-desktop"
docker info >/dev/null 2>&1 || fail "Docker daemon is not running. Start Docker Desktop and try again."
command -v npx >/dev/null 2>&1 || fail "Node.js / npx is not installed. Install Node.js 18+ from https://nodejs.org"

# Check if ports are available
for port in 9200 4317 4318; do
  if lsof -i ":${port}" >/dev/null 2>&1; then
    fail "Port ${port} is already in use. Stop the process using it and try again."
  fi
done

ok "Prerequisites satisfied"

# --- Clone or locate repo ---
if [ -f "docker-compose.yml" ] && grep -q "agent-health-network" docker-compose.yml 2>/dev/null; then
  info "Using existing agent-health directory"
  PROJECT_DIR="$(pwd)"
elif [ -d "${REPO_DIR}" ] && [ -f "${REPO_DIR}/docker-compose.yml" ]; then
  info "Found existing ${REPO_DIR}/ directory"
  PROJECT_DIR="$(cd "${REPO_DIR}" && pwd)"
else
  info "Cloning agent-health repository..."
  git clone --depth 1 "${REPO_URL}" "${REPO_DIR}"
  PROJECT_DIR="$(cd "${REPO_DIR}" && pwd)"
fi

cd "${PROJECT_DIR}"

# --- Start Docker stack ---
info "Starting OpenSearch observability stack..."
docker compose up -d

# --- Wait for OpenSearch ---
info "Waiting for OpenSearch to be ready (this may take up to 2 minutes)..."
MAX_WAIT=120
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  if curl -s -k -u "admin:${OPENSEARCH_PASSWORD}" https://localhost:9200/_cluster/health 2>/dev/null | grep -qE '"status":"(green|yellow)"'; then
    break
  fi
  sleep 5
  ELAPSED=$((ELAPSED + 5))
  printf '.'
done
echo

if [ $ELAPSED -ge $MAX_WAIT ]; then
  warn "OpenSearch is still starting. It may need more time."
  warn "Check status with: docker compose ps"
  warn "You can continue once OpenSearch is healthy."
else
  ok "OpenSearch is ready"
fi

# --- Write agent-health.config.json ---
CONFIG_FILE="${PROJECT_DIR}/agent-health.config.json"
info "Writing observability config to agent-health.config.json..."

if [ -f "${CONFIG_FILE}" ]; then
  # Merge observability into existing config using a simple approach
  # Check if observability key already exists
  if grep -q '"observability"' "${CONFIG_FILE}" 2>/dev/null; then
    warn "agent-health.config.json already has an observability section — skipping config write"
  else
    # Insert observability before the closing brace
    # Use a temp file for portability
    TMP_FILE=$(mktemp)
    sed '$ d' "${CONFIG_FILE}" > "${TMP_FILE}"
    # Add comma after last property if needed
    if tail -1 "${TMP_FILE}" | grep -qE '[^,{]$'; then
      echo ',' >> "${TMP_FILE}"
    fi
    cat >> "${TMP_FILE}" <<JSONEOF
  "observability": {
    "endpoint": "https://localhost:9200",
    "username": "admin",
    "password": "${OPENSEARCH_PASSWORD}",
    "tlsSkipVerify": true
  }
}
JSONEOF
    mv "${TMP_FILE}" "${CONFIG_FILE}"
    ok "Updated existing agent-health.config.json with observability config"
  fi
else
  cat > "${CONFIG_FILE}" <<JSONEOF
{
  "observability": {
    "endpoint": "https://localhost:9200",
    "username": "admin",
    "password": "${OPENSEARCH_PASSWORD}",
    "tlsSkipVerify": true
  }
}
JSONEOF
  ok "Created agent-health.config.json with observability config"
fi

# --- Copy .env.docker for any remaining env-based config ---
if [ -f ".env.docker" ] && [ ! -f ".env" ]; then
  cp .env.docker .env
  ok "Copied .env.docker → .env"
elif [ -f ".env" ]; then
  info ".env already exists — skipping copy"
fi

# --- Start Agent Health ---
echo
ok "Observability stack is running!"
echo
info "Services:"
echo "  OpenSearch:         https://localhost:9200"
echo "  OTel Collector:     http://localhost:4317 (gRPC) / http://localhost:4318 (HTTP)"
echo "  Data Prepper:       http://localhost:21890"
echo
info "Starting Agent Health..."
echo
npx @opensearch-project/agent-health
