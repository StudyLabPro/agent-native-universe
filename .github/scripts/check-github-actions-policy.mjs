#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";

const workflowDirectory = new URL("../workflows/", import.meta.url);
const workflowNames = (await readdir(workflowDirectory))
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();

const failures = [];
const workflows = new Map();

for (const name of workflowNames) {
  const text = await readFile(new URL(name, workflowDirectory), "utf8");
  workflows.set(name, text);

  if (/^\s*schedule\s*:/m.test(text)) {
    failures.push(`${name}: scheduled workflows are not permitted`);
  }

  for (const match of text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+).*$/gm)) {
    const reference = match[1];
    const immutable = reference.startsWith("./")
      || /^docker:\/\/[^@]+@sha256:[0-9a-f]{64}$/i.test(reference)
      || /^[^@]+@[0-9a-f]{40}$/i.test(reference);
    if (!immutable) failures.push(`${name}: mutable action reference ${reference}`);
  }

  const lines = text.split("\n");
  const jobsLine = lines.findIndex((line) => line === "jobs:");
  if (jobsLine === -1) {
    failures.push(`${name}: missing jobs section`);
    continue;
  }

  for (let index = jobsLine + 1; index < lines.length; index += 1) {
    const jobMatch = lines[index].match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (!jobMatch) continue;

    let end = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[next])) {
        end = next;
        break;
      }
    }

    const job = lines.slice(index, end).join("\n");
    if (/^    runs-on:/m.test(job) && !/^    timeout-minutes:\s*\d+/m.test(job)) {
      failures.push(`${name}: job ${jobMatch[1]} has no timeout-minutes`);
    }
    index = end - 1;
  }
}

const pullRequestGate = workflows.get("ci.yml") ?? "";
if (!/^  pull_request:\s*$/m.test(pullRequestGate)) {
  failures.push("ci.yml: PR Gate must use pull_request");
}
if (/^  push:\s*$/m.test(pullRequestGate) || pullRequestGate.includes("agent/**")) {
  failures.push("ci.yml: PR Gate must not run for branch pushes");
}
if (!pullRequestGate.includes("github.event.pull_request.draft == false")) {
  failures.push("ci.yml: PR Gate must skip draft pull requests");
}
if (!pullRequestGate.includes("- edited")) {
  failures.push("ci.yml: PR Gate must validate base-branch retargeting");
}
if (!pullRequestGate.includes("cancel-in-progress:")) {
  failures.push("ci.yml: PR Gate must cancel stale pull-request runs");
}
if (!/^  gate:\s*$/m.test(pullRequestGate) || !/^    name:\s*PR Gate\s*$/m.test(pullRequestGate)) {
  failures.push("ci.yml: missing stable one-job PR Gate context");
}
if ((pullRequestGate.match(/^    runs-on:/gm) ?? []).length !== 1) {
  failures.push("ci.yml: PR Gate must allocate exactly one runner job");
}
if (!pullRequestGate.includes("docker build --file Dockerfile.lab")) {
  failures.push("ci.yml: path-aware PR Gate must retain the container image build");
}
if (!pullRequestGate.includes("actionlint_1.7.7_linux_amd64.tar.gz")) {
  failures.push("ci.yml: PR Gate must retain pinned semantic workflow validation");
}

const heavyValidation = workflows.get("heavy-validation.yml") ?? "";
if (!/^  workflow_dispatch:\s*$/m.test(heavyValidation)) {
  failures.push("heavy-validation.yml: heavy validation must be manually dispatched");
}
if (/^  (push|pull_request|schedule):\s*$/m.test(heavyValidation)) {
  failures.push("heavy-validation.yml: heavy validation must not run automatically");
}

const release = workflows.get("release.yml") ?? "";
if (!release.includes('      - "v*.*.*"')) {
  failures.push("release.yml: version-tag release trigger changed");
}
if (!release.includes('git merge-base --is-ancestor "${release_commit}" origin/master')) {
  failures.push("release.yml: release tags must remain on master history");
}
if (!release.includes("--draft") || !release.includes('gh release edit "${GITHUB_REF_NAME}" --draft=false')) {
  failures.push("release.yml: release assets must be attached before immutable publication");
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`ERROR: ${failure}\n`);
  process.exit(1);
}

process.stdout.write(`Validated ${workflowNames.length} GitHub Actions workflows.\n`);
