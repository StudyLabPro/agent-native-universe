# Networked Byzantine Consensus

`NetworkByzantineNode` (`src/v2/network-consensus.ts`) extends the static-committee safety core into an authenticated multi-node protocol. Every replica keeps its own Ed25519 private key; no coordinator receives or impersonates another member's key.

## Message flow

```text
leader
  └─ signed bft.proposal ─────────────► replicas
                                      │
replicas                              │ validate proposal, sequence and state transition
  └─ signed bft.vote ─────────────────► leader
                                      │
leader                                │ collect 2f+1 unique accept votes
  └─ signed bft.commit certificate ──► replicas
                                      │
replicas                              │ verify every signature, fsync WAL, apply reducer
                                      ▼
                              replicated graph state
```

All messages travel through `SecureTransport` over real length-framed TCP connections. The transport verifies sender key pinning, recipient, timestamp, signature and replay nonce before consensus code receives a message.

## Fault model

For committee size `n`, the implementation uses:

```text
f = floor((n - 1) / 3)
quorum = 2f + 1
```

Four replicas therefore tolerate one unavailable or Byzantine replica for commit safety and quorum progress, assuming the other three can communicate.

The leader cannot fabricate quorum because every vote is independently signed on the voter's machine. Duplicate voters, non-members, altered commands, wrong sequence/view and signature substitution are rejected.

## Persistence and recovery

The node itself persists nothing. Every accepted certificate is handed to the embedding through the `applyCommit` callback (`NetworkByzantineOptions.applyCommit`), and it is the embedding that decides whether to write it — `AutonomousMeshNode` applies the certified command to its graph store; nothing writes a certificate file. After a restart the embedding re-arms the node from its own durable log with `restore(sequence, view)`; the node refuses to move the sequence or view backwards.

There is no certified catch-up protocol: a replica that missed certificates is not brought up to date by its peers over the wire. Until such a sync exists, a returning replica must obtain the missing certificates from its embedding's replicated store and re-verify them with `verifyCertificate` before applying them.

## View change

Replicas can emit signed `bft.view-change` messages (`requestViewChange`). A new deterministic leader becomes active only after a quorum of unique valid view-change signatures targets the same higher view.

## Verified scenarios

The network integration suite (`test/autonomous-runtime.test.mjs`) starts four independent node instances with separate identities and TCP listeners. It verifies:

1. proposal and votes cross real sockets and form a three-signature certificate;
2. the three reachable graphs converge on the same command;
3. the committee continues committing with one replica offline.

The static-committee core (`test/distributed-v1.test.mjs`) verifies that a quorum needs `2f+1` unique signatures, that duplicated voters and forged payloads are rejected, and that a view change elects the next deterministic leader only after quorum timeout votes. Catch-up of a returning replica over the network is **not** verified because it is not implemented.

## Boundary

This is a PBFT-style authenticated static-committee implementation, not a formally verified complete consensus product. Production evolution still requires dynamic membership/reconfiguration, checkpoint certificates and log compaction, automatic timeout pacemakers, equivocation evidence and slashing policy, WAN/partition testing, formal model checking and independent security review.
