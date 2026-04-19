// Centralized env var resolution + startup validation.
//
// Every consumer should import resolved constants from here rather than
// reading `process.env` directly, so empty-string overrides ("FOO=") don't
// silently bypass the default value. This module used to live inline inside
// learning.ts/api.chat.tsx, each using `??` — which only falls back on
// null/undefined. Setting `OLLAMA_CHAT_MODEL=` (empty) produced a "model is
// required" error from Ollama at first chat call. Consolidating here with
// `.trim() || fallback` closes that hole in one place.

function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const STRAPI_URL = readEnv('STRAPI_URL') ?? 'http://localhost:1337';
const STRAPI_API_TOKEN = readEnv('STRAPI_API_TOKEN');

const TRANSCRIPT_PROXY_URL = readEnv('TRANSCRIPT_PROXY_URL');

const OLLAMA_BASE_URL = readEnv('OLLAMA_BASE_URL') ?? 'http://localhost:11434/v1';
// Ollama's native HTTP API doesn't use the `/v1` OpenAI-compat suffix, but our
// env var keeps it for backward compatibility with older `.env` files. Strip.
const OLLAMA_HOST = OLLAMA_BASE_URL.replace(/\/v1\/?$/, '');

const OLLAMA_MODEL = readEnv('OLLAMA_MODEL') ?? 'gemma4-kb:latest';
const OLLAMA_CHAT_MODEL = readEnv('OLLAMA_CHAT_MODEL') ?? OLLAMA_MODEL;

const MAP_CONCURRENCY = (() => {
  const parsed = parseInt(readEnv('MAP_CONCURRENCY') ?? '1', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, 4);
})();

// One-shot startup validation. Runs at module load — the first import in any
// request path prints warnings once per process. Doesn't throw: local-first
// should degrade gracefully, and most of these are "works but not ideal".
let validated = false;
function validateOnce() {
  if (validated) return;
  validated = true;
  const warn = (msg: string) => console.warn(`[env] ${msg}`);
  if (!OLLAMA_MODEL) {
    warn('OLLAMA_MODEL resolved to an empty string — Ollama will reject every call with "model is required".');
  }
  if (!OLLAMA_CHAT_MODEL) {
    warn('OLLAMA_CHAT_MODEL resolved to empty — chat + query rewrite will fail.');
  }
  if (!STRAPI_URL) {
    warn('STRAPI_URL resolved to empty — Strapi calls will fail.');
  }
}
validateOnce();

export {
  STRAPI_URL,
  STRAPI_API_TOKEN,
  TRANSCRIPT_PROXY_URL,
  OLLAMA_BASE_URL,
  OLLAMA_HOST,
  OLLAMA_MODEL,
  OLLAMA_CHAT_MODEL,
  MAP_CONCURRENCY,
};
