import { queueTtlMs } from "./config.mjs";
import { queue } from "./store.mjs";
import { getTimestamp, nowIso } from "./utils.mjs";

export function removeQueuedPlayer(playerId) {
  const index = queue.findIndex((entry) => entry.playerId === playerId);
  if (index === -1) {
    return null;
  }
  return queue.splice(index, 1)[0];
}

export function isQueueEntryExpired(entry) {
  return !entry?.joinedAt || Number.isNaN(getTimestamp(entry.joinedAt)) || Date.now() - getTimestamp(entry.joinedAt) > queueTtlMs;
}

export function pruneQueue() {
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    if (isQueueEntryExpired(queue[index])) {
      queue.splice(index, 1);
    }
  }
}

export function enqueuePlayer(player) {
  if (!player?.playerId || queue.some((entry) => entry.playerId === player.playerId)) {
    return;
  }
  queue.push({
    playerId: player.playerId,
    displayName: player.displayName,
    deck: player.deck,
    joinedAt: nowIso()
  });
}

export function createQueuedEntry(playerId, displayName, deck) {
  return {
    playerId,
    displayName,
    deck,
    joinedAt: nowIso()
  };
}
