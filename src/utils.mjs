export function nowIso() {
  return new Date().toISOString();
}

export function getTimestamp(value) {
  return new Date(value).getTime();
}

export function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
