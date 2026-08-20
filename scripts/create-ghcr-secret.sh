#!/usr/bin/env bash

# Helper script to create or update the Kubernetes docker-registry secret (ghcr-pull)
# for pulling private images from GitHub Container Registry (ghcr.io).

set -euo pipefail

SECRET_NAME="ghcr-pull"
NAMESPACE="default"
GITHUB_USER=""
GITHUB_TOKEN=""

usage() {
    echo "Usage: $0 [-u <github-username>] [-t <github-token>] [-n <namespace>] [-s <secret-name>]"
    echo ""
    echo "Options:"
    echo "  -u, --username   GitHub username (or organization member handle)"
    echo "  -t, --token      GitHub Personal Access Token (PAT) with read:packages scope"
    echo "  -n, --namespace  Kubernetes namespace (default: ${NAMESPACE})"
    echo "  -s, --secret     Secret name (default: ${SECRET_NAME})"
    echo "  -h, --help       Show this help message"
    exit 1
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        -u|--username)
            GITHUB_USER="$2"
            shift 2
            ;;
        -t|--token)
            GITHUB_TOKEN="$2"
            shift 2
            ;;
        -n|--namespace)
            NAMESPACE="$2"
            shift 2
            ;;
        -s|--secret)
            SECRET_NAME="$2"
            shift 2
            ;;
        -h|--help)
            usage
            ;;
        *)
            echo "Error: Unknown argument $1"
            usage
            ;;
    esac
done

# Prompt interactively if not provided via flags
if [[ -z "${GITHUB_USER}" ]]; then
    read -rp "Enter GitHub username: " GITHUB_USER
fi

if [[ -z "${GITHUB_TOKEN}" ]]; then
    read -rsp "Enter GitHub Personal Access Token (PAT with read:packages scope): " GITHUB_TOKEN
    echo ""
fi

if [[ -z "${GITHUB_USER}" || -z "${GITHUB_TOKEN}" ]]; then
    echo "Error: Both GitHub username and Personal Access Token are required." >&2
    exit 1
fi

# Ensure kubectl is installed
if ! command -v kubectl &>/dev/null; then
    echo "Error: 'kubectl' CLI tool is not installed or not in PATH." >&2
    exit 1
fi

echo "Creating/updating Kubernetes secret '${SECRET_NAME}' in namespace '${NAMESPACE}'..."

kubectl create secret docker-registry "${SECRET_NAME}" \
    --docker-server=ghcr.io \
    --docker-username="${GITHUB_USER}" \
    --docker-password="${GITHUB_TOKEN}" \
    --namespace="${NAMESPACE}" \
    --dry-run=client -o yaml | kubectl apply -f -

echo "Successfully configured secret '${SECRET_NAME}' in namespace '${NAMESPACE}'."
echo ""
echo "Next steps:"
echo "  1. Verify the secret was created: kubectl get secret ${SECRET_NAME} -n ${NAMESPACE}"
echo "  2. Deploy/upgrade Helm release: helm upgrade --install dietetyk ./charts/dietetyk -n ${NAMESPACE}"
