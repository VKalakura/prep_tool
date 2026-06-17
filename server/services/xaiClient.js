/** Default if XAI_MODEL unset — current latest non-reasoning slug as of 2026 (chat-completions, fast). */
const DEFAULT_MODEL = process.env.XAI_MODEL || 'grok-4.20-0309-non-reasoning';
const XAI_BASE = (process.env.XAI_API_BASE || 'https://api.x.ai/v1').replace(/\/$/, '');

/** xAI: 10_000_000_000 ticks = 1 USD (per official docs) */
function ticksToUsd(ticks) {
  if (typeof ticks !== 'number' || !Number.isFinite(ticks)) return null;
  return ticks / 10_000_000_000;
}

/**
 * @param {object} params
 * @param {Array<{role:string,content:string}>} params.messages
 * @param {string} [params.model]
 * @param {boolean} [params.jsonMode]
 */
async function chatCompletion({ messages, model, jsonMode, maxCompletionTokens }) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    const err = new Error('XAI_API_KEY is not set. Add it to server/.env (never commit keys).');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const cap = typeof maxCompletionTokens === 'number' && maxCompletionTokens > 0
    ? maxCompletionTokens
    : 8192;

  const body = {
    model: model || DEFAULT_MODEL,
    messages,
    temperature: 0.25,
    max_completion_tokens: cap,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetch(`${XAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey.trim()}`,
    },
    body: JSON.stringify(body),
  });

  const rawText = await res.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    const err = new Error(`xAI response not JSON (HTTP ${res.status})`);
    err.code = 'BAD_RESPONSE';
    err.status = res.status;
    throw err;
  }

  if (!res.ok) {
    const msg = data?.error?.message || data?.message || rawText.slice(0, 400);
    const err = new Error(msg || `xAI HTTP ${res.status}`);
    err.code = 'XAI_HTTP';
    err.status = res.status;
    throw err;
  }

  const choice = data.choices?.[0]?.message?.content;
  const usage = data.usage || {};
  let ticks = usage.cost_in_usd_ticks;
  if (ticks == null && usage.completion_tokens_details?.cost_in_usd_ticks != null) {
    ticks = usage.completion_tokens_details.cost_in_usd_ticks;
  }
  const costUsdExact = ticksToUsd(ticks);

  return {
    content: typeof choice === 'string' ? choice : '',
    usage: {
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
      cost_in_usd_ticks: ticks ?? null,
      cost_usd: costUsdExact,
      model: data.model || model || DEFAULT_MODEL,
      num_sources_used: usage.num_sources_used,
    },
    raw: data,
  };
}

module.exports = { chatCompletion, ticksToUsd, DEFAULT_MODEL };
