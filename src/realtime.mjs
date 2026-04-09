import { WebSocketServer } from "ws";
import { findMatchByPlayerId, createPlayerScopedState, expireTimedPhases } from "./match-service.mjs";
import { queue, matches } from "./store.mjs";

const sockets = new Set();

function safeSend(socket, payload) {
  if (socket.readyState !== socket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(payload));
}

function getQueueSnapshot(playerId) {
  const match = findMatchByPlayerId(playerId);
  if (match) {
    return {
      status: match.status === "active" ? "matched" : match.status,
      matchId: match.matchId,
      opponent: match.players.find((player) => player.playerId !== playerId) || null
    };
  }
  const queued = queue.find((entry) => entry.playerId === playerId);
  return {
    status: queued ? "queued" : "idle",
    matchId: null,
    opponent: null
  };
}

export function createRealtimeServer(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (socket) => {
    socket.subscriptions = {
      queuePlayerId: null,
      matchPlayerId: null,
      matchId: null
    };
    sockets.add(socket);

    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw));
        if (message.type === "subscribe_queue") {
          socket.subscriptions.queuePlayerId = String(message.playerId || "").trim() || null;
          if (socket.subscriptions.queuePlayerId) {
            safeSend(socket, {
              type: "queue_status",
              playerId: socket.subscriptions.queuePlayerId,
              payload: getQueueSnapshot(socket.subscriptions.queuePlayerId)
            });
          }
          return;
        }
        if (message.type === "subscribe_match") {
          socket.subscriptions.matchPlayerId = String(message.playerId || "").trim() || null;
          socket.subscriptions.matchId = String(message.matchId || "").trim() || null;
          if (socket.subscriptions.matchPlayerId && socket.subscriptions.matchId) {
            const match = findMatchByPlayerId(socket.subscriptions.matchPlayerId);
            if (match && match.matchId === socket.subscriptions.matchId) {
              const scoped = createPlayerScopedState(match, socket.subscriptions.matchPlayerId);
              if (scoped) {
                safeSend(socket, {
                  type: "match_state",
                  matchId: socket.subscriptions.matchId,
                  playerId: socket.subscriptions.matchPlayerId,
                  payload: scoped
                });
              }
            }
          }
          return;
        }
        if (message.type === "unsubscribe_match") {
          socket.subscriptions.matchPlayerId = null;
          socket.subscriptions.matchId = null;
          return;
        }
        if (message.type === "unsubscribe_queue") {
          socket.subscriptions.queuePlayerId = null;
        }
      } catch (_error) {
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  const interval = setInterval(() => {
    for (const match of matches.values()) {
      if (!match || match.status !== "active" || match.gameState.phase !== "redraw" || !match.gameState.redrawDeadlineAt) {
        continue;
      }
      const beforePhase = match.gameState.phase;
      const beforeDeadline = match.gameState.redrawDeadlineAt;
      const beforeStates = match.players.map((player) => {
        const state = match.gameState.players[player.playerId];
        return state ? `${state.redrawComplete}-${state.redrawRemaining}` : "";
      });
      expireTimedPhases(match);
      const afterPhase = match.gameState.phase;
      const afterDeadline = match.gameState.redrawDeadlineAt;
      const afterStates = match.players.map((player) => {
        const state = match.gameState.players[player.playerId];
        return state ? `${state.redrawComplete}-${state.redrawRemaining}` : "";
      });
      const changed = beforePhase !== afterPhase
        || beforeDeadline !== afterDeadline
        || beforeStates.some((state, index) => state !== afterStates[index]);
      if (changed) {
        broadcastMatchState(match);
      }
    }
  }, 1000);

  wss.on("close", () => {
    clearInterval(interval);
  });

  return wss;
}

export function broadcastQueueStatus(playerId) {
  if (!playerId) {
    return;
  }
  const snapshot = getQueueSnapshot(playerId);
  for (const socket of sockets) {
    if (socket.subscriptions?.queuePlayerId === playerId) {
      safeSend(socket, {
        type: "queue_status",
        playerId,
        payload: snapshot
      });
    }
  }
}

export function broadcastMatchState(match) {
  if (!match) {
    return;
  }
  expireTimedPhases(match);
  for (const player of match.players) {
    const scoped = createPlayerScopedState(match, player.playerId);
    if (!scoped) {
      continue;
    }
    for (const socket of sockets) {
      if (socket.subscriptions?.matchPlayerId === player.playerId && socket.subscriptions?.matchId === match.matchId) {
        safeSend(socket, {
          type: "match_state",
          matchId: match.matchId,
          playerId: player.playerId,
          payload: scoped
        });
      }
    }
  }
}
