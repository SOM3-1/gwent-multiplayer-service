export const port = Number(process.env.PORT || 3001);
export const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
export const queueTtlMs = 3 * 60 * 1000;
export const turnDurationMs = 45 * 1000;
