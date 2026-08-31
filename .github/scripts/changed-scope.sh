#!/usr/bin/env bash
set -euo pipefail

base_sha="${BASE_SHA:-}"
head_sha="${HEAD_SHA:-HEAD}"

if [[ -n "${base_sha}" && ! "${base_sha}" =~ ^0+$ ]] && git cat-file -e "${base_sha}^{commit}" 2>/dev/null; then
  diff_args=("${base_sha}...${head_sha}")
else
  parent_sha="$(git rev-parse --verify "${head_sha}^" 2>/dev/null || true)"
  if [[ -n "${parent_sha}" ]]; then
    diff_args=("${parent_sha}...${head_sha}")
  else
    empty_tree="$(git hash-object -t tree /dev/null)"
    diff_args=("${empty_tree}" "${head_sha}")
  fi
fi

git diff --check "${diff_args[@]}"

runtime=false
container=false
changed_count=0

while IFS= read -r -d '' path; do
  changed_count=$((changed_count + 1))

  case "${path}" in
    package.json|package-lock.json|tsconfig.json|tsconfig.test.json|dist/*|src/*|test/*|validation/*|experiments/*|scripts/*.mjs)
      runtime=true
      ;;
    *.md|LICENSE|.gitignore|.github/*|.dockerignore|.env.example|Dockerfile*|compose*.yml)
      ;;
    *)
      # Unknown non-documentation paths take the safer runtime path.
      runtime=true
      ;;
  esac

  case "${path}" in
    .dockerignore|.env.example|Dockerfile*|compose*.yml|package.json|package-lock.json|tsconfig.json|tsconfig.test.json|src/*|experiments/*)
      container=true
      ;;
  esac
done < <(git diff --name-only --no-renames -z "${diff_args[@]}")

if [[ "${changed_count}" -eq 0 ]]; then
  runtime=true
fi

output="runtime=${runtime}"$'\n'"container=${container}"$'\n'"changed_count=${changed_count}"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf '%s\n' "${output}" >> "${GITHUB_OUTPUT}"
else
  printf '%s\n' "${output}"
fi
