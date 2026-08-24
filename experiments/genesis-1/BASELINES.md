# §33 control arms — readouts on the default seed

The first two runs of the `baselines` command, recorded because both produced
findings the plan's hypothesis (§0) has to answer to. Every number below comes
from hash-chained evidence that `replay` verifies end to end; both runs are
byte-reproducible from a clean checkout.

## Running it

```bash
npm run build
# Readout 1 — before any pressure regime bites
node dist/lab/runner.js baselines --data-dir ./runs --ticks 200 --arms A,C,D,E,F
# Readout 2 — the full crisis program (delete ./runs first: arm identities are stable)
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
| A self-organizing | 98.5% | 9.12 | 5 |
| C free physics    | 99.0% | 0    | 5 |
| D no links        | 98.0% | 8.46 | 5 |
| E central dispatch | 96.0% | 7.60 | 12 |
| F fixed roles     | 96.0% | 10.62 | 12 |

Three findings, each with a mechanism:

1. **Self-organization beats both designed architectures** on success and tail
   latency. Static routing pays head-of-line blocking; decentralized claiming
   behaves like work stealing.
2. **The relational graph contributes nothing measurable at this scale**: arm D
   matches arm A at lower cost with zero links. The advantage came from freedom
   of task choice, not from the graph.
3. **The designed QA class is pure overhead** while the evaluator is exact:
   arm F is strictly dominated by arm E.

## Readout 2 — 600 ticks, the full crisis program

Final cumulative metrics (1203 tasks each):

| arm | success | expired | credits/task | p95 | resource Gini (ppm) |
| --- | ------: | ------: | -----------: | --: | ------------------: |
| A | 98.1% | 4   | 10.56 | 10 | 2 958 |
| C | 98.4% | 2   | 0     | 10 | 1 334 |
| D | 98.3% | 4   | 10.26 | 10 | 3 968 |
| E | 97.6% | 0   | 9.63  | 14 | 4 614 |
| F | **74.1%** | **217** | 14.25 | 24 | 43 112 |

Pareto frontier: **C, D, E** (A is dominated by D within this single seed's
noise; F is dominated outright).

Success within each pressure window, by task creation tick:

| arm | 1–100 base | 101–200 credits ×2 | 201–300 bandwidth ÷2 | 301–400 −20% agents | 401–575 load ×4 |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 100 | 100 | 99 | 100 | 99.6 |
| C | 100 | 100 | 100 | 100 | 99.7 |
| D | 100 | 100 | 99 | 100 | 99.6 |
| E | 100 | 100 | 100 | 100 | 100 |
| F | 100 | 100 | 99 | 100 | **68.9** |

**Every arm absorbs the price shock, the bandwidth cut and the retirement.**
The arms only separate under the load spike — and there the fixed-role
organization does not degrade, it collapses.

### The mechanism of arm F's collapse

The arithmetic is exact. A solver's task cycle is three ticks (claim, execute,
submit), so one solver sustains ⅓ task per tick. Arm F froze 4 of 16 agents as
verifiers at genesis; the tick-300 retirement then took three *solvers*
(N0003, N0006, N0014 — no verifier was hit), leaving 9 solvers:

- arm F capacity: 9 × ⅓ = **3.0 tasks/tick** against a demand of **4.0**;
- arm E capacity: all 13 survivors solve, 13 × ⅓ ≈ **4.33** — above demand,
  and E's zero expiries confirm it, but with almost no slack;
- arms A/D: the same 13 agents, plus the freedom to rebalance — 3 expiries
  each inside the spike window, 4 across the whole run.

A structural deficit has no equilibrium: F's expiry wave accelerates
(42, then 81, then 90 per 50 ticks) with p95 latency pinned at the 25-tick
deadline. Meanwhile its verifiers attested 890 of 892 submissions over the
whole run and **every verdict was true** — six hundred ticks of QA that never
caught a defect, holding reserved capacity that was exactly the difference
between absorbing the crisis and drowning in it.

### What this says about the hypothesis

- The §0 advantage of self-organization is not throughput in a fixed regime —
  designed dispatch matches or beats it there. It is **robustness to regime
  change**: an architecture tuned to one load has no slack for another, and a
  frozen role split cannot convert idle QA into production when the queue
  grows.
- The one designed arm that survived (E) survived by 8% of margin. Halve the
  roster's luck at tick 300 or raise the spike to ×5 and the same arithmetic
  sinks it. The self-organizing arms have no such cliff in reach: their
  capacity is the whole population.
- Finding 2 from readout 1 still stands at 600 ticks: D matches A through
  every crisis. The graph remains decorative at this scale; freedom of
  claiming is doing all the work.

## Caveats

The three caveats embedded in `comparison.json` apply to both readouts: arms
share the task distribution but not the task realization (each `runId` seeds
its own stream); one run per arm, so gaps smaller than seed-to-seed variance
mean nothing — the A-versus-D ordering flipped between readouts inside that
noise, while the F collapse is 25 points and structural; and arm F's
verification coverage is bounded by the 64-submission public window (never
approached here: ≤16 agents submit per tick).

The capacity arithmetic depends on the config: `tasksPerTick`, the ×4
multiplier, the 20% retirement and the 3-tick solver cycle together place the
break-even at 12 solving agents. That the crisis landed almost exactly on the
boundary between E (13 workers) and F (9 workers) is what makes this seed
instructive, not universal.
