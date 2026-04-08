import { cardData } from "./card-data.mjs";

export function getCardId(cardEntry) {
  return Number(cardEntry?.cardId ?? cardEntry);
}

export function serializeCardInstance(cardEntry) {
  return {
    instanceId: String(cardEntry.instanceId),
    cardId: getCardId(cardEntry)
  };
}

export function getCardDefinition(cardId) {
  return cardData[String(getCardId(cardId))] || null;
}

export function getCardAbilities(cardId) {
  const definition = getCardDefinition(cardId);
  if (!definition || !definition.ability) {
    return [];
  }
  return String(definition.ability).trim().split(/\s+/).filter(Boolean);
}

export function isSupportedFixedRowUnit(cardId) {
  const definition = getCardDefinition(cardId);
  if (!definition || !["close", "ranged", "siege"].includes(definition.row)) {
    return false;
  }
  const abilities = getCardAbilities(cardId);
  const allowedAbilities = new Set(["hero", "bond", "morale", "horn", "mardroeme", "berserker"]);
  return abilities.every((ability) => allowedAbilities.has(ability));
}

export function isSupportedAgileUnit(cardId) {
  const definition = getCardDefinition(cardId);
  if (!definition || definition.row !== "agile") {
    return false;
  }
  const abilities = getCardAbilities(cardId);
  const allowedAbilities = new Set(["hero", "morale"]);
  return abilities.length === 0 || abilities.every((ability) => allowedAbilities.has(ability));
}

export function isSupportedSpyUnit(cardId) {
  const definition = getCardDefinition(cardId);
  if (!definition || !["close", "ranged", "siege"].includes(definition.row)) {
    return false;
  }
  const abilities = getCardAbilities(cardId);
  return abilities.includes("spy");
}

export function isSupportedMedicUnit(cardId) {
  const definition = getCardDefinition(cardId);
  if (!definition || !["close", "ranged", "siege"].includes(definition.row)) {
    return false;
  }
  const abilities = getCardAbilities(cardId);
  return abilities.includes("medic");
}

export function isSupportedAvengerUnit(cardId) {
  const definition = getCardDefinition(cardId);
  if (!definition || !["close", "ranged", "siege"].includes(definition.row)) {
    return false;
  }
  const abilities = getCardAbilities(cardId);
  return abilities.includes("avenger") || abilities.includes("avenger_kambi");
}

export function isSupportedMusterUnit(cardId) {
  const definition = getCardDefinition(cardId);
  if (!definition || !["close", "ranged", "siege"].includes(definition.row)) {
    return false;
  }
  const abilities = getCardAbilities(cardId);
  return abilities.includes("muster");
}

export function isSupportedWeatherCard(cardId) {
  const definition = getCardDefinition(cardId);
  if (!definition || definition.deck !== "weather") {
    return false;
  }
  const abilities = getCardAbilities(cardId);
  return abilities.length > 0 && abilities.every((ability) => ["clear", "frost", "fog", "rain", "storm"].includes(ability));
}

export function isSupportedHornSpecial(cardId) {
  const definition = getCardDefinition(cardId);
  if (!definition || definition.deck !== "special") {
    return false;
  }
  return getCardAbilities(cardId).length === 1 && getCardAbilities(cardId)[0] === "horn";
}

export function isSupportedDecoySpecial(cardId) {
  const definition = getCardDefinition(cardId);
  if (!definition || definition.deck !== "special") {
    return false;
  }
  return getCardAbilities(cardId).length === 1 && getCardAbilities(cardId)[0] === "decoy";
}

export function isSupportedScorchSpecial(cardId) {
  const definition = getCardDefinition(cardId);
  if (!definition || definition.deck !== "special") {
    return false;
  }
  return getCardAbilities(cardId).length === 1 && getCardAbilities(cardId)[0] === "scorch";
}

export function isSupportedMardroemeSpecial(cardId) {
  const definition = getCardDefinition(cardId);
  if (!definition || definition.deck !== "special") {
    return false;
  }
  return getCardAbilities(cardId).length === 1 && getCardAbilities(cardId)[0] === "mardroeme";
}

export function isSupportedRowScorchUnit(cardId) {
  const definition = getCardDefinition(cardId);
  if (!definition || !["close", "ranged", "siege"].includes(definition.row)) {
    return false;
  }
  const abilities = getCardAbilities(cardId);
  return abilities.some((ability) => ["scorch_c", "scorch_r", "scorch_s"].includes(ability));
}

const musterGroups = new Map([
  [18, [18, 19]],
  [19, [18, 19]],
  [98, [98, 99, 100, 101]],
  [99, [98, 99, 100, 101]],
  [100, [98, 99, 100, 101]],
  [101, [98, 99, 100, 101]],
  [105, [105, 106, 107]],
  [106, [105, 106, 107]],
  [107, [105, 106, 107]],
  [117, [117, 118, 119]],
  [118, [117, 118, 119]],
  [119, [117, 118, 119]],
  [127, [127, 128, 129]],
  [128, [127, 128, 129]],
  [129, [127, 128, 129]],
  [131, [131, 132, 133, 134, 135]],
  [132, [131, 132, 133, 134, 135]],
  [133, [131, 132, 133, 134, 135]],
  [134, [131, 132, 133, 134, 135]],
  [135, [131, 132, 133, 134, 135]],
  [151, [151, 152, 153]],
  [152, [151, 152, 153]],
  [153, [151, 152, 153]],
  [155, [155, 156, 157]],
  [156, [155, 156, 157]],
  [157, [155, 156, 157]],
  [162, [162, 163, 164]],
  [163, [162, 163, 164]],
  [164, [162, 163, 164]],
  [184, [184, 187, 188, 189]],
  [200, [200]]
]);

export function getMusterGroup(cardId) {
  return musterGroups.get(getCardId(cardId)) || null;
}

const berserkerTransforms = new Map([
  [181, 206],
  [210, 207]
]);

export function getBerserkerTransformCardId(cardId) {
  return berserkerTransforms.get(getCardId(cardId)) || null;
}

const avengerSummons = new Map([
  [20, 21],
  [199, 196]
]);

export function getAvengerReplacementCardId(cardId) {
  return avengerSummons.get(getCardId(cardId)) || null;
}

export function getActiveWeatherAbilities(weatherCardIds) {
  const active = new Set();
  for (const weatherCardId of weatherCardIds) {
    for (const ability of getCardAbilities(weatherCardId)) {
      if (["frost", "fog", "rain"].includes(ability)) {
        active.add(ability);
      }
    }
  }
  return active;
}

export function calculateCardStrength(cardId, activeWeather, halfWeather = false) {
  const definition = getCardDefinition(cardId);
  if (!definition) {
    return 0;
  }
  const baseStrength = Number(definition.strength) || 0;
  const abilities = getCardAbilities(cardId);
  if (abilities.includes("hero")) {
    return baseStrength;
  }
  const weatherByRow = {
    close: "frost",
    ranged: "fog",
    siege: "rain"
  };
  if (weatherByRow[definition.row] && activeWeather.has(weatherByRow[definition.row])) {
    return halfWeather ? Math.max(1, Math.ceil(baseStrength / 2)) : Math.min(1, baseStrength);
  }
  return baseStrength;
}
