import { randomUUID } from "node:crypto";
import { turnDurationMs } from "./config.mjs";
import { matches } from "./store.mjs";
import {
  calculateCardStrength,
  getActiveWeatherAbilities,
  getAvengerReplacementCardId,
  getBerserkerTransformCardId,
  getCardAbilities,
  getCardDefinition,
  getCardId,
  getMusterGroup,
  isSupportedAgileUnit,
  isSupportedAvengerUnit,
  isSupportedDecoySpecial,
  isSupportedFixedRowUnit,
  isSupportedHornSpecial,
  isSupportedMardroemeSpecial,
  isSupportedMedicUnit,
  isSupportedMusterUnit,
  isSupportedRowScorchUnit,
  isSupportedScorchSpecial,
  isSupportedSpyUnit,
  isSupportedWeatherCard,
  serializeCardInstance
} from "./cards.mjs";
import { enqueuePlayer } from "./queue-service.mjs";
import { nowIso, shuffle } from "./utils.mjs";

export function expandDeck(deckJson) {
  const deck = JSON.parse(deckJson);
  const cards = [];
  for (const [cardId, count] of deck.cards) {
    for (let i = 0; i < count; i += 1) {
      cards.push(cardId);
    }
  }
  return {
    faction: deck.faction,
    leader: deck.leader,
    cards
  };
}

export function createCardInstance(cardId) {
  return {
    instanceId: randomUUID(),
    cardId: Number(cardId)
  };
}

function getEventCardRef(cardEntry) {
  return {
    cardId: getCardId(cardEntry),
    cardInstanceId: cardEntry?.instanceId || null
  };
}

function findCardIndexByInstanceId(cards, cardInstanceId) {
  return cards.findIndex((cardEntry) => cardEntry.instanceId === cardInstanceId);
}

export function resolveHandIndex(cards, payload) {
  const cardInstanceId = String(payload.cardInstanceId || "").trim();
  if (cardInstanceId) {
    const handIndex = findCardIndexByInstanceId(cards, cardInstanceId);
    return {
      cardInstanceId,
      handIndex
    };
  }
  const fallbackHandIndex = Number.parseInt(payload.handIndex, 10);
  return {
    cardInstanceId: "",
    handIndex: Number.isInteger(fallbackHandIndex) ? fallbackHandIndex : -1
  };
}

function createPlayerGameState(player) {
  const parsedDeck = expandDeck(player.deck);
  const shuffledDeck = shuffle(parsedDeck.cards).map(createCardInstance);
  const hand = shuffledDeck.splice(0, 10);
  const leaderAbilities = getCardAbilities(parsedDeck.leader);
  return {
    playerId: player.playerId,
    faction: parsedDeck.faction,
    leader: parsedDeck.leader,
    hand,
    deck: shuffledDeck,
    grave: [],
    rows: {
      close: [],
      ranged: [],
      siege: []
    },
    specialRows: {
      close: null,
      ranged: null,
      siege: null
    },
    halfWeather: leaderAbilities.includes("king_bran"),
    leaderBlocked: false,
    leaderUsed: false,
    redrawRemaining: 2,
    redrawComplete: false,
    health: 2,
    total: 0,
    passed: false
  };
}

function createPublicDeckSnapshot(deckJson) {
  const parsedDeck = expandDeck(deckJson);
  return {
    faction: parsedDeck.faction,
    leader: parsedDeck.leader
  };
}

function createInitialGameState(host, guest, firstTurnPlayerId) {
  const hostState = createPlayerGameState(host);
  const guestState = createPlayerGameState(guest);
  const hostLeaderAbility = getCardAbilities(hostState.leader)[0] || "";
  const guestLeaderAbility = getCardAbilities(guestState.leader)[0] || "";
  if (hostLeaderAbility === "francesca_daisy" && hostState.deck.length > 0) {
    hostState.hand.push(hostState.deck.shift());
  }
  if (guestLeaderAbility === "francesca_daisy" && guestState.deck.length > 0) {
    guestState.hand.push(guestState.deck.shift());
  }
  if (hostLeaderAbility === "emhyr_whiteflame" || guestLeaderAbility === "emhyr_whiteflame") {
    hostState.leaderBlocked = true;
    guestState.leaderBlocked = true;
  }
  return {
    phase: "waiting_ready",
    redrawDeadlineAt: null,
    pendingChoice: null,
    weather: [],
    randomRespawn: hostLeaderAbility === "emhyr_invader" || guestLeaderAbility === "emhyr_invader",
    doubleSpyPower: hostLeaderAbility === "eredin_treacherous" || guestLeaderAbility === "eredin_treacherous",
    round: 1,
    turnNumber: 1,
    currentTurnPlayerId: firstTurnPlayerId,
    firstTurnPlayerId,
    players: {
      [host.playerId]: hostState,
      [guest.playerId]: guestState
    }
  };
}

export function setTurnDeadline(match) {
  match.turnDeadlineAt = new Date(Date.now() + turnDurationMs).toISOString();
}

export function clearTurnDeadline(match) {
  match.turnDeadlineAt = null;
}

export function createMatch(playerA, playerB) {
  const matchId = randomUUID();
  const host = {
    slot: "host",
    playerId: playerA.playerId,
    displayName: playerA.displayName,
    deck: playerA.deck,
    passed: false,
    forfeited: false
  };
  const guest = {
    slot: "guest",
    playerId: playerB.playerId,
    displayName: playerB.displayName,
    deck: playerB.deck,
    passed: false,
    forfeited: false
  };
  const firstTurnPlayerId = Math.random() < 0.5 ? host.playerId : guest.playerId;
  const match = {
    matchId,
    createdAt: nowIso(),
    status: "matched",
    gameMode: "pvp",
    round: 1,
    turnNumber: 1,
    firstTurnPlayerId,
    currentTurnPlayerId: firstTurnPlayerId,
    turnDeadlineAt: null,
    winnerPlayerId: null,
    readyPlayerIds: [],
    eventSeq: 0,
    eventLog: [],
    actionLog: [],
    players: [host, guest],
    gameState: createInitialGameState(host, guest, firstTurnPlayerId)
  };
  matches.set(matchId, match);
  return match;
}

export function findMatchByPlayerId(playerId) {
  return [...matches.values()].find((match) =>
    match.players.some((player) => player.playerId === playerId)
  );
}

export function deleteMatchesForPlayer(playerId, statuses = []) {
  for (const [matchId, match] of matches.entries()) {
    const includesPlayer = match.players.some((player) => player.playerId === playerId);
    if (!includesPlayer) {
      continue;
    }
    if (statuses.length > 0 && !statuses.includes(match.status)) {
      continue;
    }
    matches.delete(matchId);
  }
}

export function createPlayerScopedState(match, playerId) {
  const self = match.players.find((player) => player.playerId === playerId);
  const opponent = match.players.find((player) => player.playerId !== playerId) || null;

  if (!self) {
    return null;
  }
  const eventLog = match.eventLog.map((event) => sanitizeEventForPlayer(event, playerId));
  return {
    matchId: match.matchId,
    status: match.status,
    gameMode: match.gameMode,
    createdAt: match.createdAt,
    round: match.round,
    turnNumber: match.turnNumber,
    currentTurnPlayerId: match.currentTurnPlayerId,
    turnDeadlineAt: match.turnDeadlineAt,
    winnerPlayerId: match.winnerPlayerId,
    readyPlayerIds: match.readyPlayerIds,
    eventLog,
    self: {
      playerId: self.playerId,
      displayName: self.displayName,
      deck: self.deck,
      slot: self.slot,
      ready: match.readyPlayerIds.includes(self.playerId),
      passed: self.passed,
      forfeited: self.forfeited,
      leaderAvailable: isLeaderActivationAvailable(match.gameState.players[self.playerId]),
      halfWeather: !!match.gameState.players[self.playerId].halfWeather,
      hand: match.gameState.players[self.playerId].hand.map(serializeCardInstance),
      deckCards: match.gameState.players[self.playerId].deck.map(serializeCardInstance),
      handCount: match.gameState.players[self.playerId].hand.length,
      deckCount: match.gameState.players[self.playerId].deck.length,
      graveCount: match.gameState.players[self.playerId].grave.length,
      rows: {
        close: match.gameState.players[self.playerId].rows.close.map(serializeCardInstance),
        ranged: match.gameState.players[self.playerId].rows.ranged.map(serializeCardInstance),
        siege: match.gameState.players[self.playerId].rows.siege.map(serializeCardInstance)
      },
      specialRows: {
        close: match.gameState.players[self.playerId].specialRows.close ? getCardId(match.gameState.players[self.playerId].specialRows.close) : null,
        ranged: match.gameState.players[self.playerId].specialRows.ranged ? getCardId(match.gameState.players[self.playerId].specialRows.ranged) : null,
        siege: match.gameState.players[self.playerId].specialRows.siege ? getCardId(match.gameState.players[self.playerId].specialRows.siege) : null
      },
      redrawRemaining: match.gameState.players[self.playerId].redrawRemaining,
      redrawComplete: match.gameState.players[self.playerId].redrawComplete,
      total: match.gameState.players[self.playerId].total,
      health: match.gameState.players[self.playerId].health
    },
    opponent: opponent ? {
      playerId: opponent.playerId,
      displayName: opponent.displayName,
      deck: createPublicDeckSnapshot(opponent.deck),
      slot: opponent.slot,
      ready: match.readyPlayerIds.includes(opponent.playerId),
      passed: opponent.passed,
      forfeited: opponent.forfeited,
      leaderAvailable: isLeaderActivationAvailable(match.gameState.players[opponent.playerId]),
      halfWeather: !!match.gameState.players[opponent.playerId].halfWeather,
      handCount: match.gameState.players[opponent.playerId].hand.length,
      deckCount: match.gameState.players[opponent.playerId].deck.length,
      graveCount: match.gameState.players[opponent.playerId].grave.length,
      rows: {
        close: match.gameState.players[opponent.playerId].rows.close.map(serializeCardInstance),
        ranged: match.gameState.players[opponent.playerId].rows.ranged.map(serializeCardInstance),
        siege: match.gameState.players[opponent.playerId].rows.siege.map(serializeCardInstance)
      },
      specialRows: {
        close: match.gameState.players[opponent.playerId].specialRows.close ? getCardId(match.gameState.players[opponent.playerId].specialRows.close) : null,
        ranged: match.gameState.players[opponent.playerId].specialRows.ranged ? getCardId(match.gameState.players[opponent.playerId].specialRows.ranged) : null,
        siege: match.gameState.players[opponent.playerId].specialRows.siege ? getCardId(match.gameState.players[opponent.playerId].specialRows.siege) : null
      },
      redrawRemaining: match.gameState.players[opponent.playerId].redrawRemaining,
      redrawComplete: match.gameState.players[opponent.playerId].redrawComplete,
      total: match.gameState.players[opponent.playerId].total,
      health: match.gameState.players[opponent.playerId].health
    } : null,
    actionLog: match.actionLog,
    gameState: {
      phase: match.gameState.phase,
      weather: match.gameState.weather.map(getCardId),
      randomRespawn: !!match.gameState.randomRespawn,
      doubleSpyPower: !!match.gameState.doubleSpyPower,
      round: match.gameState.round,
      turnNumber: match.gameState.turnNumber,
      redrawDeadlineAt: match.gameState.redrawDeadlineAt,
      pendingChoice: match.gameState.pendingChoice && match.gameState.pendingChoice.playerId === playerId ? {
        type: match.gameState.pendingChoice.type,
        sourceCardId: match.gameState.pendingChoice.sourceCardId,
        sourcePlayerId: match.gameState.pendingChoice.sourcePlayerId || null,
        remainingCount: match.gameState.pendingChoice.remainingCount || null,
        options: match.gameState.pendingChoice.options.map((option) => ({
          ...serializeCardInstance(option),
          rowName: option.rowName || null
        }))
      } : null
    }
  };
}

function sanitizeEventForPlayer(event, playerId) {
  if (!event) {
    return event;
  }
  const sanitized = { ...event };
  if (sanitized.type === "cards_drawn" && sanitized.playerId !== playerId) {
    delete sanitized.cardIds;
    delete sanitized.cardInstanceIds;
  }
  if (sanitized.type === "redraw_card" && sanitized.playerId !== playerId) {
    delete sanitized.returnedCardId;
    delete sanitized.drawnCardId;
  }
  return sanitized;
}

function pushMatchEvent(match, type, payload = {}) {
  match.eventSeq += 1;
  match.eventLog.push({
    seq: match.eventSeq,
    type,
    at: nowIso(),
    ...payload
  });
  if (match.eventLog.length > 200) {
    match.eventLog = match.eventLog.slice(-200);
  }
}

export function recalculateMatchTotals(match) {
  const activeWeather = getActiveWeatherAbilities(match.gameState.weather);
  for (const player of match.players) {
    const playerState = match.gameState.players[player.playerId];
    let total = 0;
    for (const rowName of ["close", "ranged", "siege"]) {
      total += calculateRowTotal(playerState.rows[rowName], playerState.specialRows[rowName], activeWeather, !!match.gameState.doubleSpyPower, !!playerState.halfWeather);
    }
    playerState.total = total;
  }
}

function calculateRowTotal(rowCards, rowSpecial, activeWeather, doubleSpyPower = false, halfWeather = false) {
  const bondCounts = rowCards.reduce((counts, cardEntry) => {
    const abilities = getCardAbilities(cardEntry);
    if (abilities.includes("bond")) {
      const key = String(getCardId(cardEntry));
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }, {});
  const moraleCount = rowCards.reduce((count, cardEntry) => count + (getCardAbilities(cardEntry).includes("morale") ? 1 : 0), 0);
  const hornCount =
    (rowSpecial && getCardAbilities(rowSpecial).includes("horn") ? 1 : 0) +
    rowCards.reduce((count, cardEntry) => count + (getCardAbilities(cardEntry).includes("horn") ? 1 : 0), 0);
  return rowCards.reduce((sum, cardEntry) => {
    const abilities = getCardAbilities(cardEntry);
    if (abilities.includes("decoy")) {
      return sum;
    }
    let total = calculateCardStrength(cardEntry, activeWeather, halfWeather);
    if (abilities.includes("hero")) {
      return sum + total;
    }
    if (doubleSpyPower && abilities.includes("spy")) {
      total *= 2;
    }
    if (abilities.includes("bond")) {
      const bondCount = bondCounts[String(getCardId(cardEntry))] || 0;
      if (bondCount > 1) {
        total *= bondCount;
      }
    }
    total += Math.max(0, moraleCount - (abilities.includes("morale") ? 1 : 0));
    if (!abilities.includes("hero") && hornCount - (abilities.includes("horn") ? 1 : 0) > 0) {
      total *= 2;
    }
    return sum + total;
  }, 0);
}

function getAllScorchCandidates(match) {
  const activeWeather = getActiveWeatherAbilities(match.gameState.weather);
  const candidates = [];
  for (const player of match.players) {
    const playerState = match.gameState.players[player.playerId];
    for (const rowName of ["close", "ranged", "siege"]) {
      for (const cardEntry of playerState.rows[rowName]) {
        const definition = getCardDefinition(cardEntry);
        if (!definition) {
          continue;
        }
        const abilities = getCardAbilities(cardEntry);
        if (abilities.includes("hero")) {
          continue;
        }
        const power = calculateCardStrength(cardEntry, activeWeather, !!playerState.halfWeather);
        candidates.push({
          playerId: player.playerId,
          rowName,
          cardEntry,
          power
        });
      }
    }
  }
  return candidates;
}

function applyGlobalScorch(match) {
  const candidates = getAllScorchCandidates(match);
  const maxPower = candidates.reduce((max, entry) => Math.max(max, entry.power), 0);
  if (maxPower < 10) {
    return { burned: [], summoned: [] };
  }
  const burned = candidates.filter((entry) => entry.power === maxPower);
  const summoned = [];
  for (const burnedEntry of burned) {
    const playerState = match.gameState.players[burnedEntry.playerId];
    const row = playerState.rows[burnedEntry.rowName];
    const index = row.findIndex((cardEntry) => cardEntry.instanceId === burnedEntry.cardEntry.instanceId);
    if (index >= 0) {
      const [removedCard] = row.splice(index, 1);
      playerState.grave.push(removedCard);
      const summon = applyAvengerSummon(playerState, removedCard);
      if (summon) {
        summoned.push({
          playerId: burnedEntry.playerId,
          ...summon
        });
      }
    }
  }
  return {
    burned: burned.map((entry) => ({
      playerId: entry.playerId,
      rowName: entry.rowName,
      ...getEventCardRef(entry.cardEntry),
      power: entry.power
    })),
    summoned
  };
}

function applyRowScorch(match, playerId, rowName) {
  const opponent = match.players.find((player) => player.playerId !== playerId);
  if (!opponent) {
    return { burned: [], summoned: [] };
  }
  const opponentState = match.gameState.players[opponent.playerId];
  const row = opponentState.rows[rowName];
  const activeWeather = getActiveWeatherAbilities(match.gameState.weather);
  const rowTotal = calculateRowTotal(row, opponentState.specialRows[rowName], activeWeather);
  if (rowTotal < 10) {
    return { burned: [], summoned: [] };
  }
  const candidates = row
    .map((cardEntry) => {
      const abilities = getCardAbilities(cardEntry);
      if (abilities.includes("hero")) {
        return null;
      }
      return {
        cardEntry,
        power: calculateCardStrength(cardEntry, activeWeather, !!opponentState.halfWeather)
      };
    })
    .filter(Boolean);
  const maxPower = candidates.reduce((max, entry) => Math.max(max, entry.power), 0);
  const burned = candidates.filter((entry) => entry.power === maxPower);
  const summoned = [];
  for (const burnedEntry of burned) {
    const index = row.findIndex((cardEntry) => cardEntry.instanceId === burnedEntry.cardEntry.instanceId);
    if (index >= 0) {
      const [removedCard] = row.splice(index, 1);
      opponentState.grave.push(removedCard);
      const summon = applyAvengerSummon(opponentState, removedCard);
      if (summon) {
        summoned.push({
          playerId: opponent.playerId,
          ...summon
        });
      }
    }
  }
  return {
    burned: burned.map((entry) => ({
      playerId: opponent.playerId,
      rowName,
      ...getEventCardRef(entry.cardEntry),
      power: entry.power
    })),
    summoned
  };
}

function advanceTurn(match, playerId) {
  const opponent = match.players.find((player) => player.playerId !== playerId);
  if (!opponent) {
    return;
  }
  match.currentTurnPlayerId = opponent.playerId;
  match.turnNumber += 1;
  match.gameState.currentTurnPlayerId = match.currentTurnPlayerId;
  match.gameState.turnNumber = match.turnNumber;
  setTurnDeadline(match);
  pushMatchEvent(match, "turn_changed", {
    round: match.round,
    turnNumber: match.turnNumber,
    currentTurnPlayerId: match.currentTurnPlayerId,
    turnDeadlineAt: match.turnDeadlineAt
  });
}

function resolveRound(match) {
  const [playerA, playerB] = match.players;
  const stateA = match.gameState.players[playerA.playerId];
  const stateB = match.gameState.players[playerB.playerId];
  let dif = stateA.total - stateB.total;
  if (dif === 0) {
    const nilfA = stateA.faction === "nilfgaard";
    const nilfB = stateB.faction === "nilfgaard";
    dif = nilfA ^ nilfB ? (nilfA ? 1 : -1) : 0;
  }
  const winnerPlayerId = dif > 0 ? playerA.playerId : dif < 0 ? playerB.playerId : null;
  const loserPlayerId = dif > 0 ? playerB.playerId : dif < 0 ? playerA.playerId : null;
  if (loserPlayerId) {
    match.gameState.players[loserPlayerId].health = Math.max(0, match.gameState.players[loserPlayerId].health - 1);
  } else {
    stateA.health = Math.max(0, stateA.health - 1);
    stateB.health = Math.max(0, stateB.health - 1);
  }
  pushMatchEvent(match, "round_ended", {
    round: match.round,
    winnerPlayerId,
    scoreA: stateA.total,
    scoreB: stateB.total
  });
  if (stateA.health <= 0 || stateB.health <= 0) {
    match.status = "completed";
    match.gameState.phase = "completed";
    clearTurnDeadline(match);
    if (stateA.health <= 0 && stateB.health <= 0) {
      match.winnerPlayerId = null;
    } else {
      match.winnerPlayerId = stateA.health > 0 ? playerA.playerId : playerB.playerId;
    }
    pushMatchEvent(match, "match_completed", {
      winnerPlayerId: match.winnerPlayerId,
      loserPlayerId: match.winnerPlayerId === playerA.playerId ? playerB.playerId : match.winnerPlayerId === playerB.playerId ? playerA.playerId : null,
      reason: "health"
    });
    return;
  }
  resetRound(match, winnerPlayerId);
}

function resetRound(match, previousRoundWinnerPlayerId = null) {
  const keptUnits = [];
  for (const player of match.players) {
    const playerState = match.gameState.players[player.playerId];
    if (!playerState || playerState.faction !== "monsters") {
      continue;
    }
    const candidates = [];
    for (const rowName of ["close", "ranged", "siege"]) {
      for (const cardEntry of playerState.rows[rowName]) {
        const definition = getCardDefinition(cardEntry);
        if (!definition) {
          continue;
        }
        if (["close", "ranged", "siege", "agile"].includes(definition.row)) {
          candidates.push({ cardEntry, rowName });
        }
      }
    }
    if (candidates.length > 0) {
      keptUnits.push({
        playerId: player.playerId,
        ...candidates[Math.floor(Math.random() * candidates.length)]
      });
    }
  }
  const keptInstanceIds = new Set(keptUnits.map((entry) => entry.cardEntry?.instanceId).filter(Boolean));
  const skelligeRevives = [];
  match.round += 1;
  match.turnNumber += 1;
  for (const player of match.players) {
    player.passed = false;
    match.gameState.players[player.playerId].passed = false;
    const playerState = match.gameState.players[player.playerId];
    for (const rowName of ["close", "ranged", "siege"]) {
      for (const cardEntry of playerState.rows[rowName]) {
        if (keptInstanceIds.has(cardEntry.instanceId)) {
          continue;
        }
        playerState.grave.push(cardEntry);
      }
    }
    for (const rowName of ["close", "ranged", "siege"]) {
      const special = playerState.specialRows[rowName];
      if (special) {
        playerState.grave.push(special);
      }
    }
    match.gameState.players[player.playerId].rows = {
      close: [],
      ranged: [],
      siege: []
    };
    match.gameState.players[player.playerId].specialRows = {
      close: null,
      ranged: null,
      siege: null
    };
    match.gameState.players[player.playerId].total = 0;
  }
  match.gameState.weather = [];
  match.currentTurnPlayerId = match.firstTurnPlayerId;
  match.gameState.round = match.round;
  match.gameState.turnNumber = match.turnNumber;
  match.gameState.currentTurnPlayerId = match.currentTurnPlayerId;
  for (const keptUnit of keptUnits) {
    const playerState = match.gameState.players[keptUnit.playerId];
    if (!playerState) {
      continue;
    }
    playerState.rows[keptUnit.rowName].push(keptUnit.cardEntry);
    pushMatchEvent(match, "card_kept", {
      playerId: keptUnit.playerId,
      cardId: getCardId(keptUnit.cardEntry),
      rowName: keptUnit.rowName,
      reason: "monsters",
      round: match.round
    });
  }
  if (match.round === 3) {
    for (const player of match.players) {
      const playerState = match.gameState.players[player.playerId];
      if (!playerState || playerState.faction !== "skellige") {
        continue;
      }
      const graveUnits = playerState.grave.filter((cardEntry) => {
        const definition = getCardDefinition(cardEntry);
        if (!definition) {
          return false;
        }
        return ["close", "ranged", "siege", "agile"].includes(definition.row);
      });
      for (let i = Math.min(2, graveUnits.length); i > 0; i -= 1) {
        const choice = graveUnits.splice(Math.floor(Math.random() * graveUnits.length), 1)[0];
        const graveIndex = playerState.grave.findIndex((cardEntry) => cardEntry.instanceId === choice.instanceId);
        if (graveIndex < 0) {
          continue;
        }
        const [revivedCard] = playerState.grave.splice(graveIndex, 1);
        const targetRow = resolveAutoplayRow(revivedCard);
        playerState.rows[targetRow].push(revivedCard);
        skelligeRevives.push({
          playerId: player.playerId,
          ...getEventCardRef(revivedCard),
          to: targetRow
        });
      }
    }
  }
  if (previousRoundWinnerPlayerId) {
    const winnerState = match.gameState.players[previousRoundWinnerPlayerId];
    if (winnerState && winnerState.faction === "realms" && winnerState.deck.length > 0) {
      const [drawnCard] = winnerState.deck.splice(0, 1);
      winnerState.hand.push(drawnCard);
      pushMatchEvent(match, "cards_drawn", {
        playerId: previousRoundWinnerPlayerId,
        count: 1,
        cardIds: [getCardId(drawnCard)],
        cardInstanceIds: [drawnCard.instanceId],
        from: "deck",
        to: "hand",
        reason: "north",
        round: match.round
      });
    }
  }
  for (const revivedCard of skelligeRevives) {
    pushMatchEvent(match, "card_revived", {
      playerId: revivedCard.playerId,
      cardId: revivedCard.cardId,
      cardInstanceId: revivedCard.cardInstanceId,
      from: "grave",
      to: revivedCard.to,
      reason: "skellige",
      round: match.round
    });
  }
  recalculateMatchTotals(match);
  setTurnDeadline(match);
  pushMatchEvent(match, "round_started", {
    round: match.round,
    turnNumber: match.turnNumber,
    currentTurnPlayerId: match.currentTurnPlayerId,
    turnDeadlineAt: match.turnDeadlineAt
  });
}

function stayOnCurrentTurn(match) {
  match.turnNumber += 1;
  match.gameState.turnNumber = match.turnNumber;
  match.gameState.currentTurnPlayerId = match.currentTurnPlayerId;
  setTurnDeadline(match);
  pushMatchEvent(match, "turn_changed", {
    round: match.round,
    turnNumber: match.turnNumber,
    currentTurnPlayerId: match.currentTurnPlayerId,
    turnDeadlineAt: match.turnDeadlineAt
  });
}

function addCardBackToDeck(deck, cardId) {
  const index = Math.floor(Math.random() * (deck.length + 1));
  deck.splice(index, 0, cardId);
}

function finishRedrawIfReady(match) {
  const allDone = match.players.every((player) => match.gameState.players[player.playerId].redrawComplete);
  if (allDone) {
    match.gameState.phase = "active";
    match.gameState.redrawDeadlineAt = null;
    setTurnDeadline(match);
    pushMatchEvent(match, "phase_changed", {
      phase: "active",
      round: match.round,
      turnNumber: match.turnNumber
    });
    pushMatchEvent(match, "turn_changed", {
      round: match.round,
      turnNumber: match.turnNumber,
      currentTurnPlayerId: match.currentTurnPlayerId,
      turnDeadlineAt: match.turnDeadlineAt
    });
  }
}

function startRedrawPhase(match) {
  match.status = "active";
  match.gameState.phase = "redraw";
  match.gameState.redrawDeadlineAt = new Date(Date.now() + turnDurationMs).toISOString();
  clearTurnDeadline(match);
  pushMatchEvent(match, "phase_changed", {
    phase: "redraw",
    round: match.round,
    redrawDeadlineAt: match.gameState.redrawDeadlineAt
  });
}

function startPostReadyPhase(match) {
  const scoiataelPlayers = match.players.filter((player) => match.gameState.players[player.playerId].faction === "scoiatael");
  if (scoiataelPlayers.length === 1) {
    match.status = "active";
    match.gameState.phase = "choice";
    match.gameState.pendingChoice = {
      playerId: scoiataelPlayers[0].playerId,
      type: "scoiatael_first_turn",
      sourceCardId: null,
      options: []
    };
    clearTurnDeadline(match);
    pushMatchEvent(match, "choice_required", {
      playerId: scoiataelPlayers[0].playerId,
      choiceType: "scoiatael_first_turn",
      round: match.round
    });
    return;
  }
  startRedrawPhase(match);
}

function getPlayableGraveUnits(playerState) {
  return playerState.grave.filter((cardEntry) => {
    const definition = getCardDefinition(cardEntry);
    if (!definition) {
      return false;
    }
    const abilities = getCardAbilities(cardEntry);
    return ["close", "ranged", "siege", "agile"].includes(definition.row) && !abilities.includes("hero");
  });
}

function resolveMedicChoice(match, playerId, sourceCardId) {
  const self = match.players.find((player) => player.playerId === playerId);
  const opponent = match.players.find((player) => player.playerId !== playerId);
  const selfState = self ? match.gameState.players[self.playerId] : null;
  const opponentState = opponent ? match.gameState.players[opponent.playerId] : null;
  if (!selfState || !opponentState) {
    return false;
  }
  const graveOptions = getPlayableGraveUnits(selfState);
  if (graveOptions.length <= 0) {
    return false;
  }
  if (match.gameState.randomRespawn) {
    const revivedCard = graveOptions[Math.floor(Math.random() * graveOptions.length)];
    const graveIndex = selfState.grave.findIndex((graveCard) => graveCard.instanceId === revivedCard.instanceId);
    if (graveIndex < 0) {
      return false;
    }
    const [resolvedCard] = selfState.grave.splice(graveIndex, 1);
    return resolveRevivedCard(match, playerId, resolvedCard);
  }
  match.gameState.pendingChoice = {
    playerId,
    type: "medic",
    sourceCardId,
    options: graveOptions.map(serializeCardInstance)
  };
  pushMatchEvent(match, "choice_required", {
    playerId,
    choiceType: "medic",
    sourceCardId,
    optionCount: graveOptions.length,
    round: match.round
  });
  return true;
}

function resolveRevivedCard(match, playerId, revivedCard, sourcePlayerId = playerId) {
  const self = match.players.find((player) => player.playerId === playerId);
  const opponent = match.players.find((player) => player.playerId !== playerId);
  const selfState = self ? match.gameState.players[self.playerId] : null;
  const opponentState = opponent ? match.gameState.players[opponent.playerId] : null;
  if (!selfState || !opponentState || !revivedCard) {
    return false;
  }
  const revivedCardId = getCardId(revivedCard);
  const abilities = getCardAbilities(revivedCardId);
  const targetRow = resolveAutoplayRow(revivedCardId);
  const targetState = abilities.includes("spy") ? opponentState : selfState;
  const owner = abilities.includes("spy") ? "opponent" : "self";
  targetState.rows[targetRow].push(revivedCard);
  pushMatchEvent(match, "card_revived", {
    playerId,
    ...getEventCardRef(revivedCard),
    from: "grave",
    to: targetRow,
    owner,
    sourcePlayerId,
    round: match.round
  });

  if (abilities.includes("spy")) {
    const drawnCardIds = [];
    const drawnCardInstanceIds = [];
    for (let index = 0; index < 2 && selfState.deck.length > 0; index += 1) {
      const [drawnCard] = selfState.deck.splice(0, 1);
      selfState.hand.push(drawnCard);
      drawnCardIds.push(getCardId(drawnCard));
      drawnCardInstanceIds.push(drawnCard.instanceId);
    }
    pushMatchEvent(match, "cards_drawn", {
      playerId,
      count: drawnCardIds.length,
      cardIds: drawnCardIds,
      cardInstanceIds: drawnCardInstanceIds,
      from: "deck",
      to: "hand",
      round: match.round
    });
  }

  if (isSupportedMusterUnit(revivedCardId)) {
    const musteredCards = applyMuster(match, playerId, revivedCard);
    for (const musteredCard of musteredCards) {
      pushMatchEvent(match, "card_played", {
        playerId,
        ...getEventCardRef(musteredCard.cardEntry),
        from: musteredCard.from,
        to: musteredCard.to,
        owner: "self",
        autoPlayed: true,
        round: match.round
      });
    }
  }

  const transformedCards = applyBerserkerTransforms(targetState, targetRow);
  for (const transformedCard of transformedCards) {
    pushMatchEvent(match, "card_transformed", {
      playerId,
      rowName: transformedCard.rowName,
      fromCardId: transformedCard.fromCardId,
      toCardId: transformedCard.toCardId,
      round: match.round
    });
  }

  recalculateMatchTotals(match);

  if (isSupportedRowScorchUnit(revivedCardId)) {
    const scorchAbility = abilities.find((ability) => ["scorch_c", "scorch_r", "scorch_s"].includes(ability));
    const scorchRow = scorchAbility === "scorch_c" ? "close" : scorchAbility === "scorch_r" ? "ranged" : "siege";
    const scorchResult = applyRowScorch(match, playerId, scorchRow);
    recalculateMatchTotals(match);
    for (const burnedCard of scorchResult.burned) {
      pushMatchEvent(match, "card_burned", {
        playerId: burnedCard.playerId,
        cardId: burnedCard.cardId,
        cardInstanceId: burnedCard.cardInstanceId,
        from: burnedCard.rowName,
        to: "grave",
        power: burnedCard.power,
        round: match.round
      });
    }
    for (const summonedCard of scorchResult.summoned) {
      pushMatchEvent(match, "card_played", {
        playerId: summonedCard.playerId,
        ...getEventCardRef(summonedCard.cardEntry),
        from: "spawn",
        to: summonedCard.to,
        owner: "self",
        autoPlayed: true,
        round: match.round
      });
    }
  }

  if (isSupportedMedicUnit(revivedCardId)) {
    return resolveMedicChoice(match, playerId, revivedCardId);
  }
  return false;
}

function getDecoyTargets(playerState) {
  const options = [];
  for (const rowName of ["close", "ranged", "siege"]) {
    for (const cardEntry of playerState.rows[rowName]) {
      const definition = getCardDefinition(cardEntry);
      if (!definition) {
        continue;
      }
      const abilities = getCardAbilities(cardEntry);
      if (!["close", "ranged", "siege", "agile"].includes(definition.row) || abilities.includes("hero")) {
        continue;
      }
      options.push({
        ...cardEntry,
        rowName
      });
    }
  }
  return options;
}

function resolveAutoplayRow(cardId) {
  const definition = getCardDefinition(cardId);
  if (!definition) {
    return "close";
  }
  return definition.row === "agile" ? "close" : definition.row;
}

function applyMuster(match, playerId, playedCardEntry) {
  const playerState = match.gameState.players[playerId];
  const musterGroup = getMusterGroup(playedCardEntry);
  if (!playerState || !musterGroup || musterGroup.length <= 1) {
    return [];
  }
  const movedCards = [];
  for (const sourceName of ["hand", "deck"]) {
    const source = playerState[sourceName];
    for (let index = source.length - 1; index >= 0; index -= 1) {
      const candidate = source[index];
      if (!candidate || candidate.instanceId === playedCardEntry.instanceId) {
        continue;
      }
      if (!musterGroup.includes(getCardId(candidate))) {
        continue;
      }
      const [movedCard] = source.splice(index, 1);
      const targetRow = resolveAutoplayRow(movedCard);
      playerState.rows[targetRow].push(movedCard);
      movedCards.push({
        cardEntry: movedCard,
        from: sourceName,
        to: targetRow
      });
    }
  }
  return movedCards.reverse();
}

function rowHasMardroeme(playerState, rowName) {
  if (!playerState || !["close", "ranged", "siege"].includes(rowName)) {
    return false;
  }
  const rowSpecial = playerState.specialRows[rowName];
  if (rowSpecial && getCardAbilities(rowSpecial).includes("mardroeme")) {
    return true;
  }
  return playerState.rows[rowName].some((cardEntry) => getCardAbilities(cardEntry).includes("mardroeme"));
}

function applyBerserkerTransforms(playerState, rowName) {
  if (!rowHasMardroeme(playerState, rowName)) {
    return [];
  }
  const row = playerState.rows[rowName];
  const transformed = [];
  for (let index = 0; index < row.length; index += 1) {
    const cardEntry = row[index];
    const replacementCardId = getBerserkerTransformCardId(cardEntry);
    if (!replacementCardId) {
      continue;
    }
    const replacement = createCardInstance(replacementCardId);
    row[index] = replacement;
    transformed.push({
      rowName,
      fromCardId: getCardId(cardEntry),
      toCardId: replacementCardId
    });
  }
  return transformed;
}

function applyAvengerSummon(playerState, removedCard) {
  const replacementCardId = getAvengerReplacementCardId(removedCard);
  if (!replacementCardId || !playerState) {
    return null;
  }
  const summonedCard = createCardInstance(replacementCardId);
  playerState.rows.close.push(summonedCard);
  return {
    cardEntry: summonedCard,
    to: "close"
  };
}

function calculatePotentialRowScore(match, playerState, rowName, rowCards, rowSpecial, cardEntry) {
  const activeWeather = getActiveWeatherAbilities(match.gameState.weather);
  return calculateRowTotal(rowCards.concat([cardEntry]), rowSpecial, activeWeather, !!match.gameState.doubleSpyPower, !!playerState.halfWeather);
}

function getFrancescaHopeMoves(match, playerState) {
  const moves = [];
  const closeRow = playerState.rows.close;
  const rangedRow = playerState.rows.ranged;
  for (const rowName of ["close", "ranged"]) {
    const sourceRow = rowName === "close" ? closeRow : rangedRow;
    const targetRowName = rowName === "close" ? "ranged" : "close";
    const targetRow = targetRowName === "close" ? closeRow : rangedRow;
    for (const cardEntry of sourceRow) {
      const definition = getCardDefinition(cardEntry);
      if (!definition || definition.row !== "agile") {
        continue;
      }
      const currentPower = calculatePotentialRowScore(match, playerState, rowName, sourceRow.filter((entry) => entry.instanceId !== cardEntry.instanceId), playerState.specialRows[rowName], cardEntry) - calculateRowTotal(sourceRow.filter((entry) => entry.instanceId !== cardEntry.instanceId), playerState.specialRows[rowName], getActiveWeatherAbilities(match.gameState.weather), !!match.gameState.doubleSpyPower, !!playerState.halfWeather);
      const targetPower = calculatePotentialRowScore(match, playerState, targetRowName, targetRow, playerState.specialRows[targetRowName], cardEntry) - calculateRowTotal(targetRow, playerState.specialRows[targetRowName], getActiveWeatherAbilities(match.gameState.weather), !!match.gameState.doubleSpyPower, !!playerState.halfWeather);
      if (targetPower > currentPower) {
        moves.push({
          instanceId: cardEntry.instanceId,
          cardId: getCardId(cardEntry),
          from: rowName,
          to: targetRowName
        });
      }
    }
  }
  return moves;
}

function getSupportedLeaderAbility(playerState) {
  const abilities = getCardAbilities(playerState ? playerState.leader : null);
  const ability = abilities[0] || "";
  return [
    "foltest_king",
    "emhyr_imperial",
    "emhyr_emperor",
    "emhyr_whiteflame",
    "emhyr_relentless",
    "foltest_lord",
    "foltest_siegemaster",
    "foltest_steelforged",
    "foltest_son",
    "eredin_commander",
    "eredin_bringer_of_death",
    "eredin_destroyer",
    "eredin_king",
    "francesca_queen",
    "francesca_beautiful",
    "francesca_hope",
    "francesca_pureblood",
    "crach_an_craite"
  ].includes(ability) ? ability : "";
}

function isLeaderActivationAvailable(playerState) {
  return !playerState.leaderBlocked && !playerState.leaderUsed && !!getSupportedLeaderAbility(playerState);
}

function applyWeatherCardFromSource(match, selfState, cardEntry) {
  const weatherKey = getCardAbilities(cardEntry).join(" ");
  if (getCardAbilities(cardEntry).includes("clear")) {
    selfState.grave.push(cardEntry, ...match.gameState.weather);
    match.gameState.weather = [];
  } else {
    const existingIndex = match.gameState.weather.findIndex((existingCardId) => getCardAbilities(existingCardId).join(" ") === weatherKey);
    if (existingIndex >= 0) {
      selfState.grave.push(cardEntry);
    } else {
      match.gameState.weather.push(cardEntry);
    }
  }
}

export function expireTimedPhases(match) {
  const now = Date.now();
  if (match.status === "active" && match.gameState.phase === "redraw" && match.gameState.redrawDeadlineAt) {
    const redrawDeadline = new Date(match.gameState.redrawDeadlineAt).getTime();
    if (Number.isFinite(redrawDeadline) && now >= redrawDeadline) {
      for (const player of match.players) {
        const playerState = match.gameState.players[player.playerId];
        playerState.redrawComplete = true;
        playerState.redrawRemaining = 0;
      }
      finishRedrawIfReady(match);
    }
  }
}

export function applyMatchAction(match, playerId, action, payload = {}) {
  const self = match.players.find((player) => player.playerId === playerId);
  const opponent = match.players.find((player) => player.playerId !== playerId);
  const selfState = self ? match.gameState.players[self.playerId] : null;
  const opponentState = opponent ? match.gameState.players[opponent.playerId] : null;

  if (!self || !opponent || !selfState || !opponentState) {
    return { statusCode: 403, payload: { error: "Player is not part of this match." } };
  }

  if (action === "ready") {
    if (!match.readyPlayerIds.includes(playerId)) {
      match.readyPlayerIds.push(playerId);
      match.actionLog.push({
        type: "ready",
        playerId,
        at: nowIso()
      });
      pushMatchEvent(match, "player_ready", {
        playerId
      });
    }
    if (match.readyPlayerIds.length === match.players.length) {
      startPostReadyPhase(match);
    }
    return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
  }

  if (action === "decline_ready") {
    if (match.status !== "matched") {
      return { statusCode: 409, payload: { error: "Match is no longer waiting for ready confirmation." } };
    }
    match.actionLog.push({
      type: "decline_ready",
      playerId,
      at: nowIso()
    });
    pushMatchEvent(match, "player_declined_ready", {
      playerId
    });
    matches.delete(match.matchId);
    enqueuePlayer(opponent);
    return {
      statusCode: 200,
      payload: {
        status: "declined",
        matchId: match.matchId,
        requeuedOpponentPlayerId: opponent.playerId
      }
    };
  }

  if (match.status !== "active") {
    return { statusCode: 409, payload: { error: "Match is not active." } };
  }

  if (action === "redraw_card") {
    if (match.gameState.phase !== "redraw") {
      return { statusCode: 409, payload: { error: "Redraw phase is not active." } };
    }

    const { handIndex } = resolveHandIndex(selfState.hand, payload);
    if (handIndex < 0 || handIndex >= selfState.hand.length) {
      return { statusCode: 400, payload: { error: "card selection is invalid." } };
    }
    if (selfState.redrawRemaining <= 0 || selfState.redrawComplete) {
      return { statusCode: 409, payload: { error: "No redraws remaining." } };
    }
    if (selfState.deck.length <= 0) {
      return { statusCode: 409, payload: { error: "Deck is empty." } };
    }

    const [returnedCard] = selfState.hand.splice(handIndex, 1);
    const [drawnCard] = selfState.deck.splice(0, 1);
    selfState.hand.push(drawnCard);
    addCardBackToDeck(selfState.deck, returnedCard);
    selfState.redrawRemaining -= 1;
    if (selfState.redrawRemaining <= 0) {
      selfState.redrawComplete = true;
      finishRedrawIfReady(match);
    }
    match.actionLog.push({
      type: "redraw_card",
      playerId,
      at: nowIso(),
      round: match.round,
      returnedCardId: getCardId(returnedCard),
      drawnCardId: getCardId(drawnCard)
    });
    pushMatchEvent(match, "redraw_card", {
      playerId,
      round: match.round,
      returnedCardId: getCardId(returnedCard),
      drawnCardId: getCardId(drawnCard),
      redrawRemaining: selfState.redrawRemaining
    });
    return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
  }

  if (action === "finish_redraw") {
    if (match.gameState.phase !== "redraw") {
      return { statusCode: 409, payload: { error: "Redraw phase is not active." } };
    }
    selfState.redrawComplete = true;
    selfState.redrawRemaining = 0;
    match.actionLog.push({
      type: "finish_redraw",
      playerId,
      at: nowIso(),
      round: match.round
    });
    pushMatchEvent(match, "finish_redraw", {
      playerId,
      round: match.round
    });
    finishRedrawIfReady(match);
    return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
  }

  if (match.gameState.phase !== "active") {
    return { statusCode: 409, payload: { error: "Gameplay has not started yet." } };
  }

  if (action === "forfeit") {
    self.forfeited = true;
    match.status = "completed";
    match.winnerPlayerId = opponent.playerId;
    match.gameState.phase = "completed";
    clearTurnDeadline(match);
    match.actionLog.push({
      type: "forfeit",
      playerId,
      at: nowIso()
    });
    pushMatchEvent(match, "match_completed", {
      winnerPlayerId: match.winnerPlayerId,
      loserPlayerId: playerId,
      reason: "forfeit"
    });
    return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
  }

  if (action === "activate_leader") {
    if (match.currentTurnPlayerId !== playerId) {
      return { statusCode: 409, payload: { error: "It is not this player's turn." } };
    }
    if (selfState.leaderUsed) {
      return { statusCode: 409, payload: { error: "Leader ability is no longer available." } };
    }
    const leaderAbility = getSupportedLeaderAbility(selfState);
    if (!leaderAbility) {
      return { statusCode: 409, payload: { error: "This PvP build does not support that leader ability yet." } };
    }
    selfState.leaderUsed = true;
    self.passed = false;
    selfState.passed = false;
    match.gameState.phase = "active";
    match.actionLog.push({
      type: "activate_leader",
      playerId,
      at: nowIso(),
      round: match.round,
      leaderAbility
    });
    pushMatchEvent(match, "leader_activated", {
      playerId,
      leaderAbility,
      round: match.round
    });

    if (leaderAbility === "foltest_king" || leaderAbility === "emhyr_imperial" || leaderAbility === "francesca_pureblood") {
      const targetCardId =
        leaderAbility === "foltest_king" ? 9
        : leaderAbility === "emhyr_imperial" ? 11
        : 2;
      const deckIndex = selfState.deck.findIndex((cardEntry) => getCardId(cardEntry) === targetCardId);
      if (deckIndex >= 0) {
        const [weatherCard] = selfState.deck.splice(deckIndex, 1);
        applyWeatherCardFromSource(match, selfState, weatherCard);
        recalculateMatchTotals(match);
        pushMatchEvent(match, "card_played", {
          playerId,
          ...getEventCardRef(weatherCard),
          from: "deck",
          to: "weather",
          owner: "self",
          autoPlayed: true,
          round: match.round
        });
      } else
        recalculateMatchTotals(match);
    } else if (leaderAbility === "eredin_king") {
      const weatherOptions = selfState.deck.filter((cardEntry) => getCardDefinition(cardEntry)?.deck === "weather");
      if (weatherOptions.length > 0) {
        match.gameState.pendingChoice = {
          playerId,
          type: "leader_weather_deck",
          sourceCardId: selfState.leader,
          options: weatherOptions.map(serializeCardInstance)
        };
        pushMatchEvent(match, "choice_required", {
          playerId,
          choiceType: "leader_weather_deck",
          sourceCardId: selfState.leader,
          optionCount: weatherOptions.length,
          round: match.round
        });
        return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
      }
      recalculateMatchTotals(match);
    } else if (leaderAbility === "emhyr_emperor") {
      const revealOptions = shuffle(opponentState.hand.slice()).slice(0, 3);
      if (revealOptions.length > 0) {
        match.gameState.pendingChoice = {
          playerId,
          type: "leader_hand_reveal",
          sourceCardId: selfState.leader,
          sourcePlayerId: opponent.playerId,
          options: revealOptions.map(serializeCardInstance)
        };
        pushMatchEvent(match, "choice_required", {
          playerId,
          choiceType: "leader_hand_reveal",
          sourceCardId: selfState.leader,
          sourcePlayerId: opponent.playerId,
          optionCount: revealOptions.length,
          round: match.round
        });
        return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
      }
    } else if (leaderAbility === "eredin_destroyer") {
      if (selfState.hand.length >= 2) {
        match.gameState.pendingChoice = {
          playerId,
          type: "leader_discard_hand",
          sourceCardId: selfState.leader,
          remainingCount: 2,
          options: selfState.hand.map(serializeCardInstance)
        };
        pushMatchEvent(match, "choice_required", {
          playerId,
          choiceType: "leader_discard_hand",
          sourceCardId: selfState.leader,
          optionCount: selfState.hand.length,
          remainingCount: 2,
          round: match.round
        });
        return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
      }
    } else if (leaderAbility === "emhyr_relentless" || leaderAbility === "eredin_bringer_of_death") {
      const sourcePlayerId = leaderAbility === "emhyr_relentless" ? opponent.playerId : playerId;
      const sourceState = leaderAbility === "emhyr_relentless" ? opponentState : selfState;
      const graveOptions = getPlayableGraveUnits(sourceState);
      if (graveOptions.length > 0) {
        match.gameState.pendingChoice = {
          playerId,
          type: "leader_grave_to_hand",
          sourceCardId: selfState.leader,
          sourcePlayerId,
          options: graveOptions.map(serializeCardInstance)
        };
        pushMatchEvent(match, "choice_required", {
          playerId,
          choiceType: "leader_grave_to_hand",
          sourceCardId: selfState.leader,
          sourcePlayerId,
          optionCount: graveOptions.length,
          round: match.round
        });
        return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
      }
    } else if (leaderAbility === "francesca_hope") {
      const agileMoves = getFrancescaHopeMoves(match, selfState);
      for (const move of agileMoves) {
        const sourceRow = selfState.rows[move.from];
        const sourceIndex = sourceRow.findIndex((cardEntry) => cardEntry.instanceId === move.instanceId);
        if (sourceIndex < 0) {
          continue;
        }
        const [movedCard] = sourceRow.splice(sourceIndex, 1);
        selfState.rows[move.to].push(movedCard);
        pushMatchEvent(match, "card_moved", {
          playerId,
          cardId: move.cardId,
          cardInstanceId: move.instanceId,
          from: move.from,
          to: move.to,
          owner: "self",
          round: match.round
        });
      }
      recalculateMatchTotals(match);
    } else if (leaderAbility === "crach_an_craite") {
      for (const targetPlayer of match.players) {
        const targetState = match.gameState.players[targetPlayer.playerId];
        const graveCards = shuffle(targetState.grave.splice(0));
        for (const returnedCard of graveCards) {
          targetState.deck.push(returnedCard);
          pushMatchEvent(match, "card_returned", {
            playerId,
            ...getEventCardRef(returnedCard),
            from: "grave",
            to: "deck",
            sourcePlayerId: targetPlayer.playerId,
            targetPlayerId: targetPlayer.playerId,
            reason: "leader",
            round: match.round
          });
        }
      }
      recalculateMatchTotals(match);
    } else if (leaderAbility === "foltest_lord") {
      match.gameState.weather = [];
      recalculateMatchTotals(match);
    } else if (leaderAbility === "foltest_siegemaster" || leaderAbility === "eredin_commander" || leaderAbility === "francesca_beautiful") {
      const rowName =
        leaderAbility === "foltest_siegemaster" ? "siege"
        : leaderAbility === "eredin_commander" ? "close"
        : "ranged";
      if (!selfState.specialRows[rowName]) {
        selfState.specialRows[rowName] = createCardInstance(5);
        pushMatchEvent(match, "card_played", {
          playerId,
          cardId: 5,
          cardInstanceId: selfState.specialRows[rowName].instanceId,
          from: "leader",
          to: rowName,
          owner: "self",
          autoPlayed: true,
          round: match.round
        });
      }
      recalculateMatchTotals(match);
    } else {
      const scorchRow =
        leaderAbility === "foltest_steelforged" ? "siege"
        : leaderAbility === "foltest_son" ? "ranged"
        : "close";
      const scorchResult = applyRowScorch(match, playerId, scorchRow);
      recalculateMatchTotals(match);
      for (const burnedCard of scorchResult.burned) {
        pushMatchEvent(match, "card_burned", {
          playerId: burnedCard.playerId,
          cardId: burnedCard.cardId,
          cardInstanceId: burnedCard.cardInstanceId,
          from: burnedCard.rowName,
          to: "grave",
          power: burnedCard.power,
          round: match.round
        });
      }
      for (const summonedCard of scorchResult.summoned) {
        pushMatchEvent(match, "card_played", {
          playerId: summonedCard.playerId,
          ...getEventCardRef(summonedCard.cardEntry),
          from: "spawn",
          to: summonedCard.to,
          owner: "self",
          autoPlayed: true,
          round: match.round
        });
      }
    }

    if (opponent.passed) {
      stayOnCurrentTurn(match);
    } else {
      advanceTurn(match, playerId);
    }
    return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
  }

  if (match.gameState.pendingChoice) {
    if (action !== "resolve_choice") {
      return { statusCode: 409, payload: { error: "A pending card choice must be resolved first." } };
    }
    if (match.gameState.pendingChoice.playerId !== playerId) {
      return { statusCode: 409, payload: { error: "This choice belongs to the other player." } };
    }
    if (match.gameState.pendingChoice.type === "medic") {
      const selectedCardInstanceId = String(payload.selectedCardInstanceId || "").trim();
      const graveIndex = selfState.grave.findIndex((cardEntry) => cardEntry.instanceId === selectedCardInstanceId);
      if (graveIndex < 0) {
        return { statusCode: 400, payload: { error: "Selected grave card is invalid." } };
      }
      const [revivedCard] = selfState.grave.splice(graveIndex, 1);
      match.gameState.pendingChoice = null;
      const waitingOnFollowup = resolveRevivedCard(match, playerId, revivedCard);
      if (waitingOnFollowup) {
        return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
      }
      if (opponent.passed) {
        resolveRound(match);
      } else {
        advanceTurn(match, playerId);
      }
      return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
    }
    if (match.gameState.pendingChoice.type === "scoiatael_first_turn") {
      const goFirst = payload.goFirst === true || payload.goFirst === "true";
      match.firstTurnPlayerId = goFirst ? playerId : opponent.playerId;
      match.currentTurnPlayerId = match.firstTurnPlayerId;
      match.gameState.firstTurnPlayerId = match.firstTurnPlayerId;
      match.gameState.currentTurnPlayerId = match.currentTurnPlayerId;
      match.gameState.pendingChoice = null;
      pushMatchEvent(match, "turn_changed", {
        round: match.round,
        turnNumber: match.turnNumber,
        currentTurnPlayerId: match.currentTurnPlayerId,
        reason: "scoiatael_choice"
      });
      startRedrawPhase(match);
      return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
    }
    if (match.gameState.pendingChoice.type === "leader_weather_deck") {
      const selectedCardInstanceId = String(payload.selectedCardInstanceId || "").trim();
      const deckIndex = selfState.deck.findIndex((cardEntry) => cardEntry.instanceId === selectedCardInstanceId);
      if (deckIndex < 0) {
        return { statusCode: 400, payload: { error: "Selected weather card is invalid." } };
      }
      const [weatherCard] = selfState.deck.splice(deckIndex, 1);
      applyWeatherCardFromSource(match, selfState, weatherCard);
      match.gameState.pendingChoice = null;
      recalculateMatchTotals(match);
      pushMatchEvent(match, "card_played", {
        playerId,
        ...getEventCardRef(weatherCard),
        from: "deck",
        to: "weather",
        owner: "self",
        autoPlayed: true,
        round: match.round
      });
      if (opponent.passed) {
        resolveRound(match);
      } else {
        advanceTurn(match, playerId);
      }
      return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
    }
    if (match.gameState.pendingChoice.type === "leader_grave_to_hand") {
      const selectedCardInstanceId = String(payload.selectedCardInstanceId || "").trim();
      const sourcePlayerId = String(match.gameState.pendingChoice.sourcePlayerId || playerId);
      const sourceState = sourcePlayerId === playerId ? selfState : opponentState;
      const graveIndex = sourceState.grave.findIndex((cardEntry) => cardEntry.instanceId === selectedCardInstanceId);
      if (graveIndex < 0) {
        return { statusCode: 400, payload: { error: "Selected grave card is invalid." } };
      }
      const [selectedCard] = sourceState.grave.splice(graveIndex, 1);
      selfState.hand.push(selectedCard);
      match.gameState.pendingChoice = null;
      pushMatchEvent(match, "card_returned", {
        playerId,
        ...getEventCardRef(selectedCard),
        from: "grave",
        to: "hand",
        sourcePlayerId,
        targetPlayerId: playerId,
        reason: "leader",
        round: match.round
      });
      if (opponent.passed) {
        resolveRound(match);
      } else {
        advanceTurn(match, playerId);
      }
      return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
    }
    if (match.gameState.pendingChoice.type === "leader_discard_hand") {
      const selectedCardInstanceId = String(payload.selectedCardInstanceId || "").trim();
      const handIndex = selfState.hand.findIndex((cardEntry) => cardEntry.instanceId === selectedCardInstanceId);
      if (handIndex < 0) {
        return { statusCode: 400, payload: { error: "Selected hand card is invalid." } };
      }
      const [discardedCard] = selfState.hand.splice(handIndex, 1);
      selfState.grave.push(discardedCard);
      pushMatchEvent(match, "card_returned", {
        playerId,
        ...getEventCardRef(discardedCard),
        from: "hand",
        to: "grave",
        sourcePlayerId: playerId,
        targetPlayerId: playerId,
        reason: "leader",
        round: match.round
      });
      const remainingCount = Math.max(0, Number(match.gameState.pendingChoice.remainingCount || 0) - 1);
      if (remainingCount > 0 && selfState.hand.length > 0) {
        match.gameState.pendingChoice = {
          playerId,
          type: "leader_discard_hand",
          sourceCardId: selfState.leader,
          remainingCount,
          options: selfState.hand.map(serializeCardInstance)
        };
        pushMatchEvent(match, "choice_required", {
          playerId,
          choiceType: "leader_discard_hand",
          sourceCardId: selfState.leader,
          optionCount: selfState.hand.length,
          remainingCount,
          round: match.round
        });
        return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
      }
      if (selfState.deck.length > 0) {
        match.gameState.pendingChoice = {
          playerId,
          type: "leader_deck_to_hand",
          sourceCardId: selfState.leader,
          options: selfState.deck.map(serializeCardInstance)
        };
        pushMatchEvent(match, "choice_required", {
          playerId,
          choiceType: "leader_deck_to_hand",
          sourceCardId: selfState.leader,
          optionCount: selfState.deck.length,
          round: match.round
        });
        return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
      }
      match.gameState.pendingChoice = null;
      if (opponent.passed) {
        resolveRound(match);
      } else {
        advanceTurn(match, playerId);
      }
      return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
    }
    if (match.gameState.pendingChoice.type === "leader_deck_to_hand") {
      const selectedCardInstanceId = String(payload.selectedCardInstanceId || "").trim();
      const deckIndex = selfState.deck.findIndex((cardEntry) => cardEntry.instanceId === selectedCardInstanceId);
      if (deckIndex < 0) {
        return { statusCode: 400, payload: { error: "Selected deck card is invalid." } };
      }
      const [selectedCard] = selfState.deck.splice(deckIndex, 1);
      selfState.hand.push(selectedCard);
      match.gameState.pendingChoice = null;
      pushMatchEvent(match, "card_returned", {
        playerId,
        ...getEventCardRef(selectedCard),
        from: "deck",
        to: "hand",
        sourcePlayerId: playerId,
        targetPlayerId: playerId,
        reason: "leader",
        round: match.round
      });
      if (opponent.passed) {
        resolveRound(match);
      } else {
        advanceTurn(match, playerId);
      }
      return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
    }
    if (match.gameState.pendingChoice.type === "leader_hand_reveal") {
      match.gameState.pendingChoice = null;
      if (opponent.passed) {
        resolveRound(match);
      } else {
        advanceTurn(match, playerId);
      }
      return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
    }
    if (match.gameState.pendingChoice.type === "decoy") {
      const selectedCardInstanceId = String(payload.selectedCardInstanceId || "").trim();
      let selectedRowName = null;
      let selectedIndex = -1;
      for (const rowName of ["close", "ranged", "siege"]) {
        selectedIndex = selfState.rows[rowName].findIndex((cardEntry) => cardEntry.instanceId === selectedCardInstanceId);
        if (selectedIndex >= 0) {
          selectedRowName = rowName;
          break;
        }
      }
      if (!selectedRowName || selectedIndex < 0) {
        return { statusCode: 400, payload: { error: "Selected decoy target is invalid." } };
      }
      const sourceCardInstanceId = String(match.gameState.pendingChoice.sourceCardInstanceId || "").trim();
      const handIndex = selfState.hand.findIndex((cardEntry) => cardEntry.instanceId === sourceCardInstanceId);
      if (handIndex < 0) {
        return { statusCode: 409, payload: { error: "Decoy source card is no longer available." } };
      }
      const [returnedCard] = selfState.rows[selectedRowName].splice(selectedIndex, 1);
      const [decoyCard] = selfState.hand.splice(handIndex, 1);
      selfState.hand.push(returnedCard);
      selfState.rows[selectedRowName].push(decoyCard);
      match.gameState.pendingChoice = null;
      self.passed = false;
      selfState.passed = false;
      match.gameState.phase = "active";
      recalculateMatchTotals(match);
      pushMatchEvent(match, "card_returned", {
        playerId,
        ...getEventCardRef(returnedCard),
        from: selectedRowName,
        to: "hand",
        round: match.round
      });
      pushMatchEvent(match, "card_played", {
        playerId,
        ...getEventCardRef(decoyCard),
        from: "hand",
        to: selectedRowName,
        owner: "self",
        round: match.round
      });
      if (opponent.passed) {
        stayOnCurrentTurn(match);
      } else {
        advanceTurn(match, playerId);
      }
      return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
    }
    return { statusCode: 400, payload: { error: "Unsupported pending choice." } };
  }

  if (action === "pass") {
    if (match.currentTurnPlayerId !== playerId) {
      return { statusCode: 409, payload: { error: "It is not this player's turn." } };
    }

    self.passed = true;
    match.gameState.players[playerId].passed = true;
    match.actionLog.push({
      type: "pass",
      playerId,
      at: nowIso(),
      round: match.round
    });
    pushMatchEvent(match, "player_passed", {
      playerId,
      round: match.round
    });

    if (opponent.passed) {
      resolveRound(match);
    } else {
      advanceTurn(match, playerId);
    }

    match.gameState.turnNumber = match.turnNumber;
    match.gameState.currentTurnPlayerId = match.currentTurnPlayerId;

    return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
  }

  if (action === "play_card") {
    if (match.currentTurnPlayerId !== playerId) {
      return { statusCode: 409, payload: { error: "It is not this player's turn." } };
    }

    const { handIndex } = resolveHandIndex(selfState.hand, payload);

    if (handIndex < 0 || handIndex >= selfState.hand.length) {
      return { statusCode: 400, payload: { error: "card selection is invalid." } };
    }

    const cardEntry = selfState.hand[handIndex];
    const cardId = getCardId(cardEntry);
    const definition = getCardDefinition(cardId);
    const requestedRow = String(payload.targetRow || "").trim();

    if (!definition) {
      return { statusCode: 400, payload: { error: "Card metadata is unavailable." } };
    }

    let targetRow = definition.row;
    if (isSupportedWeatherCard(cardId)) {
      selfState.hand.splice(handIndex, 1);
      const weatherKey = getCardAbilities(cardId).join(" ");
      if (getCardAbilities(cardId).includes("clear")) {
        selfState.grave.push(cardEntry, ...match.gameState.weather);
        match.gameState.weather = [];
      } else {
        const existingIndex = match.gameState.weather.findIndex((existingCardId) => getCardAbilities(existingCardId).join(" ") === weatherKey);
        if (existingIndex >= 0) {
          selfState.grave.push(cardEntry);
        } else {
          match.gameState.weather.push(cardEntry);
        }
      }
      self.passed = false;
      selfState.passed = false;
      match.gameState.phase = "active";
      recalculateMatchTotals(match);
      match.actionLog.push({
        type: "play_card",
        playerId,
        at: nowIso(),
        round: match.round,
        cardId,
        targetRow: "weather"
      });
      pushMatchEvent(match, "card_played", {
        playerId,
        ...getEventCardRef(cardEntry),
        from: "hand",
        to: "weather",
        round: match.round
      });
      if (opponent.passed) {
        stayOnCurrentTurn(match);
      } else {
        advanceTurn(match, playerId);
      }
      return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
    } else if (isSupportedSpyUnit(cardId)) {
      selfState.hand.splice(handIndex, 1);
      opponentState.rows[targetRow].push(cardEntry);
      const drawnCardIds = [];
      for (let index = 0; index < 2 && selfState.deck.length > 0; index += 1) {
        const [drawnCard] = selfState.deck.splice(0, 1);
        selfState.hand.push(drawnCard);
        drawnCardIds.push(getCardId(drawnCard));
      }
      self.passed = false;
      selfState.passed = false;
      match.gameState.phase = "active";
      recalculateMatchTotals(match);
      match.actionLog.push({
        type: "play_card",
        playerId,
        at: nowIso(),
        round: match.round,
        cardId,
        targetRow,
        drawnCardIds
      });
      pushMatchEvent(match, "card_played", {
        playerId,
        ...getEventCardRef(cardEntry),
        from: "hand",
        to: targetRow,
        owner: "opponent",
        round: match.round
      });
      pushMatchEvent(match, "cards_drawn", {
        playerId,
        count: drawnCardIds.length,
        cardIds: drawnCardIds,
        cardInstanceIds: selfState.hand.slice(-drawnCardIds.length).map((card) => card.instanceId),
        from: "deck",
        to: "hand",
        round: match.round
      });
      if (opponent.passed) {
        stayOnCurrentTurn(match);
      } else {
        advanceTurn(match, playerId);
      }
      return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
    } else if (isSupportedDecoySpecial(cardId)) {
      const decoyTargets = getDecoyTargets(selfState);
      if (decoyTargets.length <= 0) {
        return { statusCode: 409, payload: { error: "No valid decoy targets are available." } };
      }
      match.gameState.pendingChoice = {
        playerId,
        type: "decoy",
        sourceCardId: cardId,
        sourceCardInstanceId: cardEntry.instanceId,
        options: decoyTargets
      };
      pushMatchEvent(match, "choice_required", {
        playerId,
        choiceType: "decoy",
        sourceCardId: cardId,
        optionCount: decoyTargets.length,
        round: match.round
      });
      return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
    } else if (isSupportedScorchSpecial(cardId)) {
      selfState.hand.splice(handIndex, 1);
      selfState.grave.push(cardEntry);
      self.passed = false;
      selfState.passed = false;
      match.gameState.phase = "active";
      const scorchResult = applyGlobalScorch(match);
      recalculateMatchTotals(match);
      match.actionLog.push({
        type: "play_card",
        playerId,
        at: nowIso(),
        round: match.round,
        cardId,
        targetRow: "grave"
      });
      pushMatchEvent(match, "card_played", {
        playerId,
        ...getEventCardRef(cardEntry),
        from: "hand",
        to: "grave",
        owner: "self",
        round: match.round
      });
      for (const burnedCard of scorchResult.burned) {
        pushMatchEvent(match, "card_burned", {
          playerId: burnedCard.playerId,
          cardId: burnedCard.cardId,
          cardInstanceId: burnedCard.cardInstanceId,
          from: burnedCard.rowName,
          to: "grave",
          power: burnedCard.power,
          round: match.round
        });
      }
      for (const summonedCard of scorchResult.summoned) {
        pushMatchEvent(match, "card_played", {
          playerId: summonedCard.playerId,
          ...getEventCardRef(summonedCard.cardEntry),
          from: "spawn",
          to: summonedCard.to,
          owner: "self",
          autoPlayed: true,
          round: match.round
        });
      }
      if (opponent.passed) {
        stayOnCurrentTurn(match);
      } else {
        advanceTurn(match, playerId);
      }
      return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
    } else if (isSupportedMardroemeSpecial(cardId)) {
      if (!["close", "ranged", "siege"].includes(requestedRow)) {
        return { statusCode: 400, payload: { error: "targetRow is invalid." } };
      }
      if (selfState.specialRows[requestedRow]) {
        return { statusCode: 409, payload: { error: "That row already has a special card." } };
      }
      selfState.hand.splice(handIndex, 1);
      selfState.specialRows[requestedRow] = cardEntry;
      self.passed = false;
      selfState.passed = false;
      match.gameState.phase = "active";
      const transformedCards = applyBerserkerTransforms(selfState, requestedRow);
      recalculateMatchTotals(match);
      match.actionLog.push({
        type: "play_card",
        playerId,
        at: nowIso(),
        round: match.round,
        cardId,
        targetRow: requestedRow
      });
      pushMatchEvent(match, "card_played", {
        playerId,
        ...getEventCardRef(cardEntry),
        from: "hand",
        to: requestedRow,
        owner: "self",
        round: match.round
      });
      for (const transformedCard of transformedCards) {
        pushMatchEvent(match, "card_transformed", {
          playerId,
          rowName: transformedCard.rowName,
          fromCardId: transformedCard.fromCardId,
          toCardId: transformedCard.toCardId,
          round: match.round
        });
      }
      if (opponent.passed) {
        stayOnCurrentTurn(match);
      } else {
        advanceTurn(match, playerId);
      }
      return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
    } else if (isSupportedHornSpecial(cardId)) {
      if (!["close", "ranged", "siege"].includes(requestedRow)) {
        return { statusCode: 400, payload: { error: "targetRow is invalid." } };
      }
      if (selfState.specialRows[requestedRow]) {
        return { statusCode: 409, payload: { error: "That row already has a special card." } };
      }
      selfState.hand.splice(handIndex, 1);
      selfState.specialRows[requestedRow] = cardEntry;
      self.passed = false;
      selfState.passed = false;
      match.gameState.phase = "active";
      recalculateMatchTotals(match);
      match.actionLog.push({
        type: "play_card",
        playerId,
        at: nowIso(),
        round: match.round,
        cardId,
        targetRow: requestedRow
      });
      pushMatchEvent(match, "card_played", {
        playerId,
        ...getEventCardRef(cardEntry),
        from: "hand",
        to: requestedRow,
        owner: "self",
        round: match.round
      });
      if (opponent.passed) {
        stayOnCurrentTurn(match);
      } else {
        advanceTurn(match, playerId);
      }
      return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
    } else if (isSupportedAgileUnit(cardId)) {
      if (!["close", "ranged"].includes(requestedRow)) {
        return { statusCode: 400, payload: { error: "Agile cards must choose close or ranged." } };
      }
      targetRow = requestedRow;
    } else if (!isSupportedFixedRowUnit(cardId) && !isSupportedMedicUnit(cardId) && !isSupportedMusterUnit(cardId) && !isSupportedAvengerUnit(cardId) && !isSupportedRowScorchUnit(cardId)) {
      return { statusCode: 409, payload: { error: "This PvP build does not support this card or its full effect yet." } };
    }

    const strength = Number(definition.strength);

    if (!["close", "ranged", "siege"].includes(targetRow)) {
      return { statusCode: 400, payload: { error: "targetRow is invalid." } };
    }

    if (!Number.isFinite(strength) || strength < 0) {
      return { statusCode: 400, payload: { error: "strength is invalid." } };
    }

    selfState.hand.splice(handIndex, 1);
    selfState.rows[targetRow].push(cardEntry);
    self.passed = false;
    selfState.passed = false;
    match.gameState.phase = "active";
    match.actionLog.push({
      type: "play_card",
      playerId,
      at: nowIso(),
      round: match.round,
      cardId,
      targetRow
    });
    pushMatchEvent(match, "card_played", {
      playerId,
      ...getEventCardRef(cardEntry),
      from: "hand",
      to: targetRow,
      owner: "self",
      round: match.round
    });

    if (isSupportedMusterUnit(cardId)) {
      const musteredCards = applyMuster(match, playerId, cardEntry);
      for (const musteredCard of musteredCards) {
        pushMatchEvent(match, "card_played", {
          playerId,
          ...getEventCardRef(musteredCard.cardEntry),
          from: musteredCard.from,
          to: musteredCard.to,
          owner: "self",
          autoPlayed: true,
          round: match.round
        });
      }
    }

    const transformedCards = applyBerserkerTransforms(selfState, targetRow);
    for (const transformedCard of transformedCards) {
      pushMatchEvent(match, "card_transformed", {
        playerId,
        rowName: transformedCard.rowName,
        fromCardId: transformedCard.fromCardId,
        toCardId: transformedCard.toCardId,
        round: match.round
      });
    }

    recalculateMatchTotals(match);

    if (isSupportedRowScorchUnit(cardId)) {
      const scorchAbility = getCardAbilities(cardId).find((ability) => ["scorch_c", "scorch_r", "scorch_s"].includes(ability));
      const scorchRow = scorchAbility === "scorch_c" ? "close" : scorchAbility === "scorch_r" ? "ranged" : "siege";
      const scorchResult = applyRowScorch(match, playerId, scorchRow);
      recalculateMatchTotals(match);
      for (const burnedCard of scorchResult.burned) {
        pushMatchEvent(match, "card_burned", {
          playerId: burnedCard.playerId,
          cardId: burnedCard.cardId,
          cardInstanceId: burnedCard.cardInstanceId,
          from: burnedCard.rowName,
          to: "grave",
          power: burnedCard.power,
          round: match.round
        });
      }
      for (const summonedCard of scorchResult.summoned) {
        pushMatchEvent(match, "card_played", {
          playerId: summonedCard.playerId,
          ...getEventCardRef(summonedCard.cardEntry),
          from: "spawn",
          to: summonedCard.to,
          owner: "self",
          autoPlayed: true,
          round: match.round
        });
      }
    }

    if (isSupportedMedicUnit(cardId)) {
      if (resolveMedicChoice(match, playerId, cardId)) {
        return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
      }
    }

    if (opponent.passed) {
      stayOnCurrentTurn(match);
    } else {
      advanceTurn(match, playerId);
    }

    return { statusCode: 200, payload: createPlayerScopedState(match, playerId) };
  }

  return { statusCode: 400, payload: { error: "Unsupported action." } };
}
