# §33 control arms — readouts on the default seed

The first readouts of the `baselines` command, recorded because both produced
findings the plan's hypothesis (§0) has to answer to. Every number below comes
from hash-chained evidence that `replay` verifies end to end; both runs are
byte-reproducible from a clean checkout.

The comparison pins one task realization for every arm
(`taskStream.realizationSeed`, set by the command to the base seed), so all
five arms face byte-identical tasks and oracles and metric gaps are
attributable to the architecture, not to per-arm task luck.

## Running it

```bash
npm run build
# Readout 1 — before any pressure regime bites
node dist/lab/runner.js baselines --data-dir ./runs --ticks 200 --arms A,C,D,E,F
# Readout 2 — the full crisis program
node dist/lab/runner.js baselines --data-dir ./runs --ticks 600 --arms A,C,D,E,F
# Windowed slices of readout 2, straight from the evidence
node experiments/genesis-1/crisis-windows.mjs \
  ./runs/genesis-1/baselines/<comparison-id>/comparison.json
```

The default config schedules four pressures: credits price ×2 at tick 100,
bandwidth capacity ÷2 at tick 200, forced retirement of 20% of agents at
tick 300, task load ×4 at tick 400. A 200-tick run therefore sees only the
price shock; a 600-tick run lives through all four and then 200 more ticks of
the hardest regime.

## Readout 1 — 200 ticks, calm weather

| arm | success | credits/task | p95 latency |
| --- | ------: | -----------: | ----------: |
| A self-organizing | 98.5% | 9.37 | 5 |
| C free physics    | 99.0% | 0    | 5 |
| D no links        | 99.0% | 8.37 | 5 |
| E central dispatch | 96.0% | 7.60 | 12 |
| F fixed roles     | 96.0% | 10.62 | 12 |

Three findings, each with a mechanism:

1. **The self-organizing arms beat both designed architectures** on success
   and tail latency (98.5–99.0% at p95 = 5 against 96.0% at p95 = 12). Static
   routing pays head-of-line blocking; decentralized claiming behaves like
   work stealing.
2. **The relational graph contributes nothing measurable at this scale**: arm
   D matches arm A's behaviour with zero links and, on this seed, strictly
   dominates it (same success as C, lower cost than A). The advantage came
   from freedom of task choice, not from the graph.
3. **The designed QA class is pure overhead** while the evaluator is exact:
   arm F is strictly dominated by arm E.

## Readout 2 — 600 ticks, the full crisis program

Final cumulative metrics (1203 tasks each):

| arm | success | expired | credits/task | p95 | resource Gini (ppm) |
| --- | ------: | ------: | -----------: | --: | ------------------: |
| A | 97.4% | 13  | 10.58 | 11 | 4 310 |
| C | 97.9% | 3   | 0     | 11 | 1 176 |
| D | 98.1% | 5   | 10.29 | 10 | 3 072 |
| E | 97.6% | 0   | 9.63  | 14 | 5 579 |
| F | **74.1%** | **217** | 14.25 | 24 | 43 934 |

Pareto frontier: **C, D, E**. A is dominated by D on this seed — the neutral
arm without links outperformed the neutral arm with them — and F is dominated
outright.

Success within each pressure window, by task creation tick:

| arm | 1–100 base | 101–200 credits ×2 | 201–300 bandwidth ÷2 | 301–400 −20% agents | 401–575 load ×4 |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 100 | 100 | 100 | 100 | 98.1 |
| C | 100 | 100 | 100 | 100 | 99.6 |
| D | 100 | 100 | 100 | 100 | 99.3 |
| E | 100 | 100 | 100 | 100 | 100 |
| F | 100 | 100 | 99 | 100 | **68.9** |

**Every arm absorbs the price shock, the bandwidth cut and the retirement.**
The arms only separate under the load spike — and there the fixed-role
organization does not degrade, it collapses.

### The mechanism of arm F's collapse

The arithmetic is exact. A solver's task cycle is three ticks (claim, execute,
submit), so one solver sustains ⅓ task per tick. Arm F froze 4 of 16 agents as
verifiers at genesis; the tick-300 retirement then took three *solvers*
(N0007, N0010, N0014 — no verifier was hit), leaving 9 solvers:

- arm F capacity: 9 × ⅓ = **3.0 tasks/tick** against a demand of **4.0**;
- arm E capacity: all 13 survivors solve, 13 × ⅓ ≈ **4.33** — above demand,
  and E's zero expiries confirm it, but with almost no slack;
- arms A/D: the same 13 agents, plus the freedom to rebalance — 13 and 5
  expiries across the whole run.

A structural deficit has no equilibrium: F's expiry wave accelerates
(42, then 81, then 90 per 50 ticks) with p95 latency pinned at the 25-tick
deadline. Meanwhile its verifiers attested 890 of 892 submissions over the
whole run and **every verdict was true** — six hundred ticks of QA that never
caught a defect, holding reserved capacity that was exactly the difference
between absorbing the crisis and drowning in it.

### What this says about the hypothesis

- The robust §33 separations on this seed are two: **a frozen role split
  collapses structurally under regime change** (25 points, a mechanism, no
  equilibrium), and **central dispatch buys its crisis survival with a
  permanent 2–3× tail-latency tax** in every calm regime. The self-organizing
  arms pay neither price — but under the spike they are not free either
  (A: 98.1% in-window against E's 100%).
- The one designed arm that survived (E) survived by 8% of margin. Halve the
  roster's luck at tick 300 or raise the spike to ×5 and the same arithmetic
  sinks it. The self-organizing arms have no such cliff in reach: their
  capacity is the whole population.
- Finding 2 from readout 1 sharpens at 600 ticks: D dominates A through every
  crisis. On this seed the graph is not merely decorative — it is a small net
  cost, and freedom of claiming is doing all the work. The plan's "living
  graph" thesis has, so far, no supporting evidence at this scale.

## Caveats

Two caveats ship inside `comparison.json` and bear repeating: one run per
arm, so gaps smaller than seed-to-seed variance mean nothing — the A/C/D/E
ordering spans 0.7 points at 600 ticks and is exactly such a gap, while the F
collapse is 25 points and structural; and arm F's verification coverage is
bounded by the 64-submission public window (never approached here: ≤16 agents
submit per tick).

The capacity arithmetic depends on the config: `tasksPerTick`, the ×4
multiplier, the 20% retirement and the 3-tick solver cycle together place the
break-even at 12 solving agents. That the crisis landed almost exactly on the
boundary between E (13 workers) and F (9 workers) is what makes this seed
instructive, not universal.
