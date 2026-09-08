import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * The publication boundary of a public repository.
 *
 * `AGENTS.md` forbids exposing "external infrastructure context" here. The
 * live-deployment phase needs exactly that context to be operable, so it lives
 * in one untracked file (`deploy/mws/target.env`, from `target.env.example`)
 * and the tracked artefacts carry variable names only.
 *
 * This test states the boundary as patterns, never as literals: writing the
 * forbidden address into the assertion would publish it just as surely as
 * leaving it in the runbook.
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Text files worth scanning; binaries and lockfiles carry no runbooks. */
const SCANNED_EXTENSIONS = new Set([
  "", ".md", ".yml", ".yaml", ".sh", ".conf", ".service", ".timer", ".env",
  ".example", ".json", ".mjs", ".ts", ".js", ".txt", ".Caddyfile",
]);

/** Paths whose whole point is to describe placeholders. */
const ALLOWED_PATHS = new Set(["deploy/mws/target.env.example"]);

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: repositoryRoot, maxBuffer: 64 * 1024 * 1024 })
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0);
}

/**
 * A dotted quad that is not documentation, not loopback, not link-local and
 * not RFC1918 — in other words, somebody's real machine.
 */
function publicIpv4Literals(text) {
  const found = [];
  for (const match of text.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g)) {
    const octets = match.slice(1, 5).map(Number);
    if (octets.some((octet) => octet > 255)) continue;
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127 || a >= 224) continue;             // reserved, private, loopback, multicast
    if (a === 172 && b >= 16 && b <= 31) continue;                           // RFC1918
    if (a === 192 && b === 168) continue;                                    // RFC1918
    if (a === 192 && b === 0) continue;                                      // RFC5737 / IETF
    if (a === 198 && (b === 18 || b === 19 || b === 51)) continue;           // benchmarking / documentation
    if (a === 203 && b === 0) continue;                                      // RFC5737
    if (a === 169 && b === 254) continue;                                    // link-local (metadata address, named on purpose)
    if (a === 100 && b >= 64 && b <= 127) continue;                          // CGNAT
    found.push(match[0]);
  }
  return found;
}

/** A cloud project identifier of the shape `project-<random>`. */
function projectIdentifiers(text) {
  return [...text.matchAll(/\bproject-[a-z0-9]{5,}\b/g)].map((match) => match[0]);
}

test("no tracked file publishes a real machine address", () => {
  const offenders = [];
  for (const path of trackedFiles()) {
    if (ALLOWED_PATHS.has(path)) continue;
    if (!SCANNED_EXTENSIONS.has(extname(path))) continue;
    let text;
    try {
      text = readFileSync(resolve(repositoryRoot, path), "utf8");
    } catch {
      continue;
    }
    const hits = publicIpv4Literals(text);
    if (hits.length > 0) offenders.push(`${path}: ${hits.length} address literal(s)`);
  }
  assert.deepEqual(
    offenders,
    [],
    "addresses belong in deploy/mws/target.env (untracked), not in the repository",
  );
});

test("no tracked file publishes the cloud project identifier", () => {
  const offenders = [];
  for (const path of trackedFiles()) {
    if (ALLOWED_PATHS.has(path)) continue;
    if (!SCANNED_EXTENSIONS.has(extname(path))) continue;
    let text;
    try {
      text = readFileSync(resolve(repositoryRoot, path), "utf8");
    } catch {
      continue;
    }
    const hits = projectIdentifiers(text);
    if (hits.length > 0) offenders.push(`${path}: ${hits.length} project identifier(s)`);
  }
  assert.deepEqual(
    offenders,
    [],
    "the project identifier comes from MWS_PROJECT in deploy/mws/target.env",
  );
});

/**
 * Third-party service endpoints a deployment file may legitimately name: they
 * are somebody else's public infrastructure, not ours. Anything else with a
 * dot in it, inside the deployment surface, is our own naming and belongs in
 * deploy/mws/target.env.
 */
const THIRD_PARTY_HOSTS = /(^|\.)(npmjs\.org|docker\.com|shields\.io|w3\.org|openai\.com|anthropic\.com|mwsapis\.ru|letsencrypt\.org|github\.com|ubuntu\.com|debian\.org|python\.org|nodejs\.org|example\.com|example\.org)$/;

/** `containerd.io` is an apt package name that happens to look like a host. */
const NOT_A_HOST = /^containerd\.io$/;

/**
 * The deployment surface — files that describe THIS deployment. Files outside
 * it (the lab docs, .env.example, compose.lab.yml) carry names the owner
 * published long ago on master; this boundary is about not adding new ones,
 * not about relitigating that decision.
 */
function isDeploymentSurface(path) {
  return path.startsWith("deploy/") || path.startsWith("scripts/live/") || path === "compose.live.yml";
}

/**
 * Only real registry zones count. Matching any dot-separated token would flag
 * file names (`compose.live.yml`) and label keys (`com.docker.compose.project`),
 * which say nothing about anyone's infrastructure.
 */
const HOSTNAME = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*\.(?:com|ru|pro|online|org|io|dev|net|ai|app|cloud|tech|info|me|xyz)\b/g;

function foreignHostnames(text) {
  const found = [];
  for (const match of text.matchAll(HOSTNAME)) {
    const host = match[0];
    if (THIRD_PARTY_HOSTS.test(host) || NOT_A_HOST.test(host)) continue;
    found.push(host);
  }
  return found;
}

test("no deployment file publishes a hostname of our own", () => {
  const offenders = [];
  for (const path of trackedFiles()) {
    if (ALLOWED_PATHS.has(path)) continue;
    if (!isDeploymentSurface(path)) continue;
    if (!SCANNED_EXTENSIONS.has(extname(path))) continue;
    let text;
    try {
      text = readFileSync(resolve(repositoryRoot, path), "utf8");
    } catch {
      continue;
    }
    const hits = foreignHostnames(text);
    if (hits.length > 0) offenders.push(`${path}: ${[...new Set(hits)].join(", ")}`);
  }
  assert.deepEqual(
    offenders,
    [],
    "hostnames of our own infrastructure come from deploy/mws/target.env, not from tracked files",
  );
});

test("the deployment artefacts reference only the untracked target file for that context", () => {
  const runbook = readFileSync(resolve(repositoryRoot, "deploy/mws/DEPLOY_LIVE.md"), "utf8");
  assert.ok(runbook.includes("deploy/mws/target.env"), "the runbook must name the local target file");
  const ignore = readFileSync(resolve(repositoryRoot, ".gitignore"), "utf8");
  assert.ok(
    ignore.split("\n").some((line) => line.trim() === "deploy/mws/target.env"),
    "deploy/mws/target.env must be ignored, or the boundary is one `git add` away from gone",
  );
});
