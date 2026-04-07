# gwent-multiplayer-service

Minimal v1 backend for `gwent-classic` multiplayer queueing.

## Run locally

```bash
npm install
npm run dev
```

The service runs on `http://localhost:3001` by default.

## Environment

Copy `.env.example` values into your shell if needed:

```bash
export PORT=3001
export ALLOWED_ORIGIN=http://localhost:5173
```

## Current API

### `GET /health`

Returns service status, queued player count, and active match count.

### `POST /queue/join`

Request body:

```json
{
  "playerId": "anonymous-client-id",
  "displayName": "Wolf-2731",
  "deck": "{\"faction\":\"realms\",\"leader\":24,\"cards\":[[5,1]]}"
}
```

Response:

```json
{
  "status": "queued",
  "matchId": null
}
```

Or, when another player is waiting:

```json
{
  "status": "matched",
  "matchId": "uuid",
  "opponent": {
    "playerId": "other-player-id",
    "displayName": "Skellige-4821"
  }
}
```

### `POST /queue/leave`

Request body:

```json
{
  "playerId": "anonymous-client-id"
}
```

### `GET /match/:matchId`

Returns the stored in-memory match payload for debugging.

## Notes

- State is in-memory only.
- Queueing works.
- Match creation works.
- Real gameplay synchronization is not implemented yet.
- This is intended to be the first backend step for the PvP UI in `gwent-classic`.
