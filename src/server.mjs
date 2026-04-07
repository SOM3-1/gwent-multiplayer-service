import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const port = Number(process.env.PORT || 3001);
const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

const queue = [];
const matches = new Map();

function nowIso() {
  return new Date().toISOString();
}

function sendJson(res, statusCode, payload, origin = "*") {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(JSON.stringify(payload));
}

function getOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) {
    return allowedOrigin === "*" ? "*" : allowedOrigin;
  }
  if (allowedOrigin === "*" || origin === allowedOrigin) {
    return origin;
  }
  return allowedOrigin;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function removeQueuedPlayer(playerId) {
  const index = queue.findIndex((entry) => entry.playerId === playerId);
  if (index === -1) {
    return null;
  }
  return queue.splice(index, 1)[0];
}

function createMatch(playerA, playerB) {
  const matchId = randomUUID();
  const match = {
    matchId,
    createdAt: nowIso(),
    status: "matched",
    players: [
      {
        playerId: playerA.playerId,
        displayName: playerA.displayName,
        deck: playerA.deck
      },
      {
        playerId: playerB.playerId,
        displayName: playerB.displayName,
        deck: playerB.deck
      }
    ]
  };
  matches.set(matchId, match);
  return match;
}

function findMatchByPlayerId(playerId) {
  return [...matches.values()].find((match) =>
    match.players.some((player) => player.playerId === playerId)
  );
}

const server = createServer(async (req, res) => {
  const origin = getOrigin(req);

  if (req.method === "OPTIONS") {
    sendJson(res, 204, {}, origin);
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "gwent-multiplayer-service",
      queuedPlayers: queue.length,
      activeMatches: matches.size
    }, origin);
    return;
  }

  if (req.method === "POST" && req.url === "/queue/join") {
    try {
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

      const existingMatch = findMatchByPlayerId(playerId);

      if (existingMatch) {
        sendJson(res, 200, {
          status: "matched",
          matchId: existingMatch.matchId,
          opponent: existingMatch.players.find((player) => player.playerId !== playerId) || null
        }, origin);
        return;
      }

      const queuedEntry = {
        playerId,
        displayName,
        deck,
        joinedAt: nowIso()
      };

      const opponent = queue.shift();

      if (!opponent) {
        queue.push(queuedEntry);
        sendJson(res, 200, {
          status: "queued",
          matchId: null
        }, origin);
        return;
      }

      const match = createMatch(opponent, queuedEntry);
      const opponentPublic = {
        playerId: opponent.playerId,
        displayName: opponent.displayName
      };

      sendJson(res, 200, {
        status: "matched",
        matchId: match.matchId,
        opponent: opponentPublic
      }, origin);
      return;
    } catch (error) {
      sendJson(res, 500, {
        error: "Unable to process queue join."
      }, origin);
      return;
    }
  }

  if (req.method === "POST" && req.url === "/queue/leave") {
    try {
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
      return;
    } catch (error) {
      sendJson(res, 500, {
        error: "Unable to process queue leave."
      }, origin);
      return;
    }
  }

  if (req.method === "GET" && req.url.startsWith("/queue/status")) {
    const url = new URL(req.url, `http://localhost:${port}`);
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
        status: "matched",
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

  if (req.method === "GET" && req.url.startsWith("/match/")) {
    const matchId = req.url.replace("/match/", "").trim();
    if (!matchId || !matches.has(matchId)) {
      sendJson(res, 404, {
        error: "Match not found."
      }, origin);
      return;
    }

    const match = matches.get(matchId);
    sendJson(res, 200, match, origin);
    return;
  }

  sendJson(res, 404, {
    error: "Route not found."
  }, origin);
});

server.listen(port, () => {
  console.log(`gwent-multiplayer-service listening on http://localhost:${port}`);
});
