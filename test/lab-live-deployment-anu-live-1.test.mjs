import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertLiveUniverseConfig, validateGenesisConfig } from "../dist/lab/index.js";
import { assertLiveTiersSpec } from "../dist/lab/live/live-cognition.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalConfigPath = join(repositoryRoot, "experiments", "genesis-live", "config.json");
const hostConfigPath = join(repositoryRoot, "experiments", "genesis-live", "config.anu-live-1.json");
const tiersPath = join(repositoryRoot, "deploy", "mws", "tiers.anu-live-1.json");
const envExamplePath = join(repositoryRoot, ".env.live.example");

/** `readSecretFile` in `runner.ts` refuses anything larger; `--tiers` goes through it. */
const MAX_SECRET_FILE_BYTES = 4_098;
/** The grader shares the gateway with the three tiers. */
const GRADER_IN_FLIGHT = 1;

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

/** `.env.live.example` carries only names and values; parse it the way Compose would. */
async function readEnvExample() {
  const text = await readFile(envExamplePath, "utf8");
  const values = new Map();
  for (const line of text.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match !== null) values.set(match[1], match[2]);
  }
  return values;
}

test("the anu-live-1 universe config is the canonical physics, resized only where the machine forces it", async () => {
  // This host has 4 vCPU, 8 GB of RAM and one 50 GB boot disk: no separate
  // evidence disk exists and none can be created (the nbs-pl2 quota is spent).
  // Exactly five values are allowed to differ from the canonical universe, and
  // every one of them is a consequence of that machine — never of taste.
  const canonical = await readJson(canonicalConfigPath);
  const host = await readJson(hostConfigPath);

  assert.doesNotThrow(() => validateGenesisConfig(host));
  assert.doesNotThrow(() => assertLiveUniverseConfig(host));
  assert.equal(host.experimentId, "genesis-live");
  assert.equal(host.live.genesisFrom, undefined, "a universe config describes epoch 0");

  // One consultation per active agent per tick: agents *are* the per-tick
  // request count against a single gateway on a single 4-vCPU machine.
  assert.equal(host.agents, 16);
  // A shorter epoch is a shorter single-threaded boundary replay, a more
  // frequent attested point and a smaller checkpoint. It stays longer than
  // the archive windows, so archival still bites inside an epoch.
  assert.equal(host.ticks, 250);
  assert.equal(host.live.epochTicks, 250);
  assert.ok(host.live.epochTicks > host.live.archive.submissionTicks);
  // A fast consultation meters on the order of 1.5–2k units here, so the
  // canonical 200000 would exhaust the whole population before the first
  // chain link. Doubling it makes exhaustion a consequence of an agent's own
  // tier choices, not of arithmetic.
  assert.equal(host.initialResources.llmTokens, 400_000);
  // Its own seed: a differently-sized universe must never be mistaken for the
  // canonical one in someone else's report.
  assert.equal(host.seed, "genesis-live-anu-live-1-u0001");

  // Everything else — prices, task stream, archive windows, tier prices,
  // exhaustion, treasury, checkpoint interval — is the canonical physics.
  const strip = (config) => {
    const copy = structuredClone(config);
    copy.agents = null;
    copy.ticks = null;
    copy.seed = null;
    copy.initialResources.llmTokens = null;
    copy.live.epochTicks = null;
    return copy;
  };
  assert.deepEqual(strip(host), strip(canonical));
  // Named explicitly, because the reasoning for keeping it is not obvious:
  // a crash costs up to checkpointEvery × agents real consultations, and on
  // this machine a re-consultation is dearer than a megabyte.
  assert.equal(host.checkpointEvery, 25);
});

test("the anu-live-1 tiers file is a valid tiers spec and prices exactly what the reducer charges", async () => {
  const raw = await readFile(tiersPath, "utf8");
  assert.ok(
    Buffer.byteLength(raw, "utf8") <= MAX_SECRET_FILE_BYTES,
    "--tiers is read through readSecretFile, which refuses a larger file",
  );
  const tiers = assertLiveTiersSpec(JSON.parse(raw));
  const host = await readJson(hostConfigPath);

  // The invariant that makes the economy of thinking honest: the port
  // predicts affordability from these prices and the reducer charges from the
  // config's. If they disagree, the debit is not the price of the tier.
  for (const tier of ["fast", "standard", "deliberate"]) {
    assert.equal(tiers[tier].pricePpm, host.live.tiers[tier].pricePpm, `${tier}.pricePpm`);
  }

  const env = await readEnvExample();
  const allowed = env.get("ANU_LIVE_LLM_MODELS").split(",");
  for (const tier of ["fast", "standard", "deliberate"]) {
    assert.ok(allowed.includes(tiers[tier].model), `the gateway allowlist must carry ${tiers[tier].model}`);
  }
  assert.ok(
    allowed.includes(env.get("ANU_LIVE_GRADER_MODEL")),
    "the gateway allowlist must carry the grader model",
  );

  // The gateway must be able to hold every tier's concurrency plus the grader
  // at once; a smaller ceiling would serialize the tiers behind each other.
  const concurrency = ["fast", "standard", "deliberate"]
    .reduce((total, tier) => total + tiers[tier].concurrency, 0);
  assert.ok(
    Number(env.get("ANU_LIVE_GATEWAY_MAX_IN_FLIGHT")) >= concurrency + GRADER_IN_FLIGHT,
    "ANU_LIVE_GATEWAY_MAX_IN_FLIGHT must cover the tiers plus the grader",
  );

  // The disk guard's built-in default (20 GiB) assumes a dedicated 300 GB
  // evidence volume. On a shared 50 GB boot disk it has to be set explicitly
  // and it has to be smaller than that default, or the universe pauses at
  // once — and larger than nothing, or it never pauses at all.
  const minFree = Number(env.get("ANU_LIVE_MIN_FREE_BYTES"));
  assert.ok(minFree > 0 && minFree < 20 * 1024 * 1024 * 1024);
});
