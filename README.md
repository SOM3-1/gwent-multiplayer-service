# gwent-multiplayer-service

Backend service for PvP support in `gwent-classic`.

This service owns matchmaking, player-scoped match state, server timers, and increasing portions of the actual game rules so PvP can behave like PvC while still remaining authoritative.

For local backend architecture documentation, see [docs/backend-architecture.md](./docs/backend-architecture.md).

## Run locally

```bash
cd gwent-multiplayer-service
npm install
npm run dev
```

Default local address:

- `http://localhost:3001`

## Environment

Example local configuration:

```bash
cd gwent-multiplayer-service
export PORT=3001
export ALLOWED_ORIGIN=http://localhost:5173
npm run dev
```

To run the frontend against this service:

```bash
cd gwent-classic
export VITE_GWENT_MULTIPLAYER_URL=http://localhost:3001
npm run dev
```

## Getting oriented

Recommended reading order:

1. [`src/server.mjs`](/Users/dush/Gwent/gwent-multiplayer-service/src/server.mjs)
2. [`src/realtime.mjs`](/Users/dush/Gwent/gwent-multiplayer-service/src/realtime.mjs)
3. [`src/match-service.mjs`](/Users/dush/Gwent/gwent-multiplayer-service/src/match-service.mjs)
4. [Backend architecture doc](./docs/backend-architecture.md)

## Service role

This backend is responsible for:

- anonymous queue matchmaking
- match creation
- player-scoped state serialization
- turn deadlines and redraw deadlines
- hidden-information protection
- validating PvP actions
- resolving backend-owned game rules
- pushing queue and match updates to clients
- enforcing redraw timeouts so matches progress even without new client actions

## Architecture

Current module layout:

- `src/server.mjs`
  - HTTP bootstrap and route wiring
- `src/realtime.mjs`
  - WebSocket subscriptions and push fanout
- `src/http.mjs`
  - JSON and CORS helpers
- `src/config.mjs`
  - runtime config
- `src/store.mjs`
  - in-memory queue and match storage
- `src/queue-service.mjs`
  - queue lifecycle
- `src/cards.mjs`
  - card metadata and supported-card helpers
- `src/match-service.mjs`
  - match creation, state serialization, deadlines, rules, and action handling
- `src/utils.mjs`
  - shared helpers

## Data model

The service currently keeps everything in memory.

Main in-memory structures:

- `queue`
  - players waiting to be matched
- `matches`
  - keyed by `matchId`
  - stores:
    - player identities
    - deck snapshots
    - authoritative match state
    - event log
    - timers and phase information

## Transport flow

Current transport model:

- HTTP
  - join queue
  - leave queue
  - fetch bootstrap
  - send actions
- WebSocket
  - queue status push
  - match state push

The frontend still uses snapshots as the source of truth, but this backend also emits ordered events so the frontend can move toward full event-driven replay.

## How snapshots work

The backend does not send one shared raw match object to both players during normal PvP flow.

Instead it builds a player-scoped snapshot for each player:

- self hand and self deck details stay visible to that player
- opponent hidden information is removed
- public board state stays shared
- event log entries are sanitized before delivery

That player-scoped snapshot is built by `createPlayerScopedState(...)` in [`src/match-service.mjs`](/Users/dush/Gwent/gwent-multiplayer-service/src/match-service.mjs).

The delivery pattern is:

1. client fetches bootstrap over HTTP
2. client subscribes over WebSocket
3. backend validates each action
4. backend mutates authoritative state and appends ordered events
5. backend pushes a fresh player-scoped snapshot to both players

This hybrid approach makes reconnect and recovery simpler while the frontend continues moving toward fuller event replay.

## Current API

### `GET /health`

Returns service status and basic counts.

### `GET /ws`

WebSocket endpoint used by the frontend.

Client subscribe messages:

```json
{ "type": "subscribe_queue", "playerId": "anonymous-client-id" }
```

```json
{ "type": "subscribe_match", "playerId": "anonymous-client-id", "matchId": "uuid" }
```

Server push messages:

```json
{ "type": "queue_status", "playerId": "anonymous-client-id", "payload": { "status": "queued", "matchId": null, "opponent": null } }
```

```json
{ "type": "match_state", "playerId": "anonymous-client-id", "matchId": "uuid", "payload": { "...": "player-scoped match state" } }
```

### `POST /queue/join`

Request body:

```json
{
  "playerId": "anonymous-client-id",
  "displayName": "Wolf-2731",
  "deck": "{\"faction\":\"realms\",\"leader\":24,\"cards\":[[5,1]]}"
}
```

### `POST /queue/leave`

Request body:

```json
{
  "playerId": "anonymous-client-id"
}
```

### `GET /queue/status?playerId=...`

Returns whether the player is still queued or already matched.

### `GET /match/:matchId?playerId=...`

Returns player-scoped bootstrap or current match state.

### `POST /match/:matchId/action`

Used for PvP actions such as:

- `ready`
- `decline_ready`
- `redraw_card`
- `finish_redraw`
- `pass`
- `forfeit`
- `play_card`
- `resolve_choice`
- `activate_leader`

## Match flow

Current server-side flow:

1. Player joins queue with an anonymous id and deck snapshot.
2. Backend either stores the player in queue or matches them immediately.
3. Once matched, backend creates a match with two player states.
4. Both players must confirm `ready`.
5. Backend decides starting player, with faction/leader overrides where applicable.
6. Backend enters redraw phase.
7. Each player redraws independently, up to 2 cards.
8. When both are done, backend enters active phase.
9. During active play:
   - action is validated
   - authoritative state is mutated
   - ordered event log entries are appended
   - updated player-scoped state is pushed
10. On round end:
   - backend resolves totals, round winner, faction effects, and next round
11. On match end:
   - winner is stored
   - completed state is pushed

## Hidden information design

The backend intentionally returns player-scoped state.

That means:

- a player sees their own hand
- a player sees their own deck snapshot where needed
- a player sees only public opponent deck metadata
- hidden draw details are sanitized from opponent event views

This is why the backend must remain authoritative for PvP.

## Current design direction

The long-term target is:

- backend owns rule legality and ordering
- backend emits ordered gameplay events
- frontend replays those events through the original board presentation
- snapshots become mainly a recovery/reconnect tool

## Current status

What is already in place:

- queue matchmaking
- ready flow
- redraw phase
- player-scoped state
- WebSocket push
- event log
- server-owned card instance ids
- server-owned turn and redraw deadlines
- many card, faction, and leader rules already ported

What is still being refined:

- exact PvC-presentation parity
- some remaining animation/event sequencing gaps
- reconnect/session hardening
- broader runtime hardening for public hosting

## Hosting notes

This service is intentionally simple to self-host:

- single Node process
- in-memory state
- no database required for local use

That also means:

- server restarts clear active matches
- horizontal scale is not supported yet
- this is still hobby-grade multiplayer infrastructure, not production-grade
