# Cross-Agent Context Contract Example

Prototype extension for agent-to-agent context requests between active Pi sessions.

It lets a supervisor-like session request context from a worker session and block until the worker owner approves, rejects, defers, or releases a scoped context bundle.

## Contract model

1. Every loaded session heartbeats into `~/.local/state/pi-agent/context-contract/sessions/`.
2. A requester calls `agent_context_request` or types `@agent:<target> <request>`.
3. The target owner session receives an `AGENT_CONTEXT_REQUEST` user message on its next available turn.
4. The owner decides using `agent_context_respond`.
5. The requester tool unblocks when the request reaches a terminal state.

Terminal states: `released`, `rejected`, `deferred`, `unknown`, `error`, `expired`.

The owner controls release. The requester never reads another session transcript directly.

## Installation

From the repository root:

```bash
mkdir -p ~/.pi/agent/extensions/cross-agent-context
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/cross-agent-context/index.ts" \
  ~/.pi/agent/extensions/cross-agent-context/index.ts
```

Restart Pi or run `/reload` in every session that should participate.

## Status line

When loaded, the extension adds a compact footer status item:

```text
ctx:<peers>p [<incoming>in] [<outgoing>out]
```

Examples:

- `ctx:0p` — no other active context peers.
- `ctx:2p 1in` — two active peers and one incoming request for this session.
- `ctx:1p 1out` — one active peer and one outbound blocker request waiting on an owner.

## Help and slash commands

```text
?                              # show full Pi agent system help
/pi-agent-help                 # same help as a slash command
/agent-context ?               # same help scoped to the context CLI
/agent-context                 # list active sessions and pending requests
/agent-context list            # same as above
/agent-context register worker-a worker
/agent-context prune           # remove stale session records and old closed requests
```

The help output documents the whole local Pi agent stack: cross-agent context contracts, status line, Agent Bus mirror, Pi background workers, job files, and safety model.

## Usage

In each worker/supervisor session, optionally register a stable alias:

```text
Register this session as alias worker-a with role worker.
```

The agent should call:

```text
agent_context_register({ alias: "worker-a", role: "worker" })
```

List available peers:

```text
/agent-context
```

or ask the agent:

```text
List active cross-agent sessions.
```

Fast request from a supervisor session:

```text
@agent:worker-a give me current status, blockers, touched files, and whether your output is ready to consume
```

Equivalent explicit tool intent:

```text
Request context from worker-a. Treat it as a blocker until released.
```

The owner session receives an `AGENT_CONTEXT_REQUEST` message and can answer with:

```text
agent_context_respond({
  requestId: "...",
  decision: "approved",
  context: "Status: ...\nFiles: ...\nRestrictions: ..."
})
```

Reject/defer when context is not ready:

```text
agent_context_respond({
  requestId: "...",
  decision: "deferred",
  reason: "Tests still running; ask again after the migration completes."
})
```

## Tools

- `agent_context_register` — set this session's alias/role.
- `agent_context_list` — list active sessions and requests.
- `agent_context_request` — create a request and optionally wait.
- `agent_context_respond` — owner-only approval/rejection/release.
- `agent_context_status` — inspect a request.

## UX flow

Supervisor path:

1. Footer shows active peers and outbound blockers.
2. Supervisor types `@agent:<alias> <request>`.
3. The model creates an `agent_context_request` with `waitForRelease: true`.
4. The tool displays wait progress and the footer shows `out` until terminal.
5. The released bundle enters the supervisor context as the tool result.

Owner path:

1. Footer shows `in` while an incoming contract is pending.
2. The extension queues an `AGENT_CONTEXT_REQUEST` prompt into the owner session.
3. Owner model decides and calls `agent_context_respond`.
4. Footer clears `in` once the request is released/rejected/deferred/unknown/error.

## Notes

- The shared store is local filesystem state, not a secure boundary.
- Do not release secrets, credentials, environment variables, or unrelated transcript content.
- Session heartbeat TTL is five minutes.
- This is a hypothesis/prototype path; a production implementation should move the contract onto the agent bus control plane.
