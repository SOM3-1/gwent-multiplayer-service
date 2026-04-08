import { createServer } from "node:http";
import { port } from "./config.mjs";
import { getOrigin, readJson, sendJson } from "./http.mjs";
import { createMatch, createPlayerScopedState, applyMatchAction, deleteMatchesForPlayer, expireTimedPhases, findMatchByPlayerId } from "./match-service.mjs";
import { pruneQueue, removeQueuedPlayer, createQueuedEntry } from "./queue-service.mjs";
import { broadcastMatchState, broadcastQueueStatus, createRealtimeServer } from "./realtime.mjs";
import { matches, queue } from "./store.mjs";

const server = createServer(async (req, res) => {
  const origin = getOrigin(req);
  const url = new URL(req.url, `http://localhost:${port}`);

  if (req.method === "OPTIONS") {
    sendJson(res, 204, {}, origin);
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    pruneQueue();
    sendJson(res, 200, {
      ok: true,
      service: "gwent-multiplayer-service",
      queuedPlayers: queue.length,
      activeMatches: matches.size
    }, origin);
    return;
  }

  if (req.method === "POST" && url.pathname === "/queue/join") {
    try {
      pruneQueue();
      const body = await readJson(req);
      const playerId = String(body.playerId || "").trim();
      const displayName = String(body.displayName || "").trim();
      const deck = String(body.deck || "").trim();

      if (!playerId || !displayName || !deck) {
        sendJson(res, 400, {
          error: "playerId, displayName, and deck are required."
        }, origin);
        return;
      }

      removeQueuedPlayer(playerId);
      deleteMatchesForPlayer(playerId, ["completed"]);

      const existingMatch = findMatchByPlayerId(playerId);
      if (existingMatch && existingMatch.status !== "completed") {
        sendJson(res, 200, {
          status: "matched",
          matchId: existingMatch.matchId,
          opponent: existingMatch.players.find((player) => player.playerId !== playerId) || null
        }, origin);
        broadcastQueueStatus(playerId);
        return;
      }

      const opponent = queue.shift();
      if (!opponent) {
        queue.push(createQueuedEntry(playerId, displayName, deck));
        sendJson(res, 200, {
          status: "queued",
          matchId: null
        }, origin);
        broadcastQueueStatus(playerId);
        return;
      }

      const match = createMatch(opponent, createQueuedEntry(playerId, displayName, deck));
      sendJson(res, 200, {
        status: "matched",
        matchId: match.matchId,
        opponent: {
          playerId: opponent.playerId,
          displayName: opponent.displayName
        }
      }, origin);
      broadcastQueueStatus(playerId);
      broadcastQueueStatus(opponent.playerId);
      broadcastMatchState(match);
      return;
    } catch (error) {
      sendJson(res, 500, {
        error: "Unable to process queue join."
      }, origin);
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/queue/leave") {
    try {
      pruneQueue();
      const body = await readJson(req);
      const playerId = String(body.playerId || "").trim();

      if (!playerId) {
        sendJson(res, 400, {
          error: "playerId is required."
        }, origin);
        return;
      }

      const removed = removeQueuedPlayer(playerId);
      sendJson(res, 200, {
        status: removed ? "left_queue" : "not_queued"
      }, origin);
      broadcastQueueStatus(playerId);
      return;
    } catch (error) {
      sendJson(res, 500, {
        error: "Unable to process queue leave."
      }, origin);
      return;
    }
  }

  if (req.method === "GET" && url.pathname === "/queue/status") {
    pruneQueue();
    const playerId = String(url.searchParams.get("playerId") || "").trim();

    if (!playerId) {
      sendJson(res, 400, {
        error: "playerId is required."
      }, origin);
      return;
    }

    const match = findMatchByPlayerId(playerId);
    if (match) {
      sendJson(res, 200, {
        status: match.status === "active" ? "matched" : match.status,
        matchId: match.matchId,
        opponent: match.players.find((player) => player.playerId !== playerId) || null
      }, origin);
      return;
    }

    const queued = queue.find((entry) => entry.playerId === playerId);
    sendJson(res, 200, {
      status: queued ? "queued" : "idle",
      matchId: null,
      opponent: null
    }, origin);
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/match/") && url.pathname.endsWith("/action")) {
    const parts = url.pathname.split("/").filter(Boolean);
    const matchId = parts[1];

    if (!matchId || !matches.has(matchId)) {
      sendJson(res, 404, {
        error: "Match not found."
      }, origin);
      return;
    }

    try {
      const body = await readJson(req);
      const playerId = String(body.playerId || "").trim();
      const action = String(body.action || "").trim();

      if (!playerId || !action) {
        sendJson(res, 400, {
          error: "playerId and action are required."
        }, origin);
        return;
      }

      const match = matches.get(matchId);
      expireTimedPhases(match);
      const result = applyMatchAction(match, playerId, action, body);
      sendJson(res, result.statusCode, result.payload, origin);
      if (result.statusCode < 400) {
        if (action === "decline_ready") {
          broadcastQueueStatus(playerId);
          if (result.payload?.requeuedOpponentPlayerId) {
            broadcastQueueStatus(result.payload.requeuedOpponentPlayerId);
          }
        } else {
          broadcastMatchState(match);
          for (const player of match.players) {
            broadcastQueueStatus(player.playerId);
          }
        }
      }
      return;
    } catch (error) {
      sendJson(res, 500, {
        error: "Unable to process match action."
      }, origin);
      return;
    }
  }

  if (req.method === "GET" && url.pathname.startsWith("/match/") && url.pathname.endsWith("/state")) {
    const parts = url.pathname.split("/").filter(Boolean);
    const matchId = parts[1];
    const playerId = String(url.searchParams.get("playerId") || "").trim();

    if (!matchId || !matches.has(matchId)) {
      sendJson(res, 404, {
        error: "Match not found."
      }, origin);
      return;
    }

    if (!playerId) {
      sendJson(res, 400, {
        error: "playerId is required."
      }, origin);
      return;
    }

    const match = matches.get(matchId);
    expireTimedPhases(match);
    const scoped = createPlayerScopedState(match, playerId);
    if (!scoped) {
      sendJson(res, 403, {
        error: "Player is not part of this match."
      }, origin);
      return;
    }

    sendJson(res, 200, scoped, origin);
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/match/")) {
    const matchId = url.pathname.replace("/match/", "").trim();

    if (!matchId || !matches.has(matchId)) {
      sendJson(res, 404, {
        error: "Match not found."
      }, origin);
      return;
    }

    const match = matches.get(matchId);
    expireTimedPhases(match);
    const playerId = String(url.searchParams.get("playerId") || "").trim();
    if (!playerId) {
      sendJson(res, 200, match, origin);
      return;
    }

    const scoped = createPlayerScopedState(match, playerId);
    if (!scoped) {
      sendJson(res, 403, {
        error: "Player is not part of this match."
      }, origin);
      return;
    }

    sendJson(res, 200, scoped, origin);
    return;
  }

  sendJson(res, 404, {
    error: "Route not found."
  }, origin);
});

createRealtimeServer(server);

server.listen(port, () => {
  console.log(`gwent-multiplayer-service listening on http://localhost:${port}`);
});
