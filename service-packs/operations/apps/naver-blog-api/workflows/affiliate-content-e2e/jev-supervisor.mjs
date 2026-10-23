import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { readWindowsJevKey } from './jev-auth.mjs';

const MODES = new Set(['off', 'shadow', 'active']);
const PROVIDERS = new Set(['auto', 'typesafe', 'vercel', 'custom']);

function boundedNumber(value, fallback, minimum = 0, maximum = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

export function jevConfig(env = process.env, overrides = {}) {
  const mode = String(overrides.mode ?? env.JEV_MODE ?? 'shadow').toLowerCase();
  const provider = String(overrides.provider ?? env.JEV_PROVIDER ?? 'auto').toLowerCase();
  if (!MODES.has(mode)) throw new Error(`Unsupported JEV_MODE: ${mode}`);
  if (!PROVIDERS.has(provider)) throw new Error(`Unsupported JEV_PROVIDER: ${provider}`);
  const localAllowed = env === process.env && mode !== 'off';
  const vercelKey = overrides.vercelKey ?? env.AI_GATEWAY_API_KEY ?? (
    localAllowed && ['auto', 'vercel'].includes(provider) ? readWindowsJevKey({ provider: 'vercel' }) : ''
  );
  const typesafeKey = overrides.typesafeKey ?? env.TYPESAFE_API_KEY ?? (
    localAllowed && (provider === 'typesafe' || provider === 'auto' && !vercelKey) ? readWindowsJevKey({ provider: 'typesafe' }) : ''
  );
  const customKey = overrides.customKey ?? env.JEV_API_KEY ?? '';
  const customEndpoint = overrides.customEndpoint ?? env.JEV_ENDPOINT ?? '';
  const resolvedProvider = provider === 'auto'
    ? vercelKey ? 'vercel' : typesafeKey ? 'typesafe' : customEndpoint && customKey ? 'custom' : null
    : provider;
  return {
    mode,
    provider: resolvedProvider,
    endpoint: resolvedProvider === 'vercel'
      ? 'https://ai-gateway.vercel.sh/typesafe/v1/systemone'
      : resolvedProvider === 'typesafe'
      ? 'https://api.typesafe.ai/v1/systemone'
      : customEndpoint,
    apiKey: resolvedProvider === 'vercel' ? vercelKey : resolvedProvider === 'typesafe' ? typesafeKey : customKey,
    model: overrides.model ?? env.JEV_MODEL ?? (resolvedProvider === 'vercel' ? 'typesafe-ai/jev' : 'jev-latest'),
    confidenceFloor: boundedNumber(overrides.confidenceFloor ?? env.JEV_MIN_CONFIDENCE, 0.82),
    timeoutMs: Math.round(boundedNumber(overrides.timeoutMs ?? env.JEV_TIMEOUT_MS, 8000, 1000, 30000)),
  };
}

function fallbackAnswer(question, fallback) {
  if (question.type === 'choice') {
    return {
      type: 'choice',
      choice: fallback,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === fallback ? 1 : 0])),
      confidence: 1,
      source: 'deterministic_fallback',
    };
  }
  if (question.type === 'score') {
    return {
      type: 'score',
      score: Number(fallback ?? 0),
      probabilities: {},
      confidence: 1,
      source: 'deterministic_fallback',
    };
  }
  return {
    type: 'noul',
    noul: fallback === true ? 1 : fallback === false ? 0 : Number(fallback ?? 0),
    source: 'deterministic_fallback',
  };
}

function validateQuestion(id, question, fallback) {
  if (!question || !['choice', 'score', 'noul'].includes(question.type)) {
    throw new Error(`Invalid Jev question type for ${id}`);
  }
  if (!question.instructions) throw new Error(`Missing Jev instructions for ${id}`);
  if (question.type === 'choice') {
    const options = question.criteria ? Object.keys(question.criteria) : [];
    if (options.length < 1) {
      throw new Error(`Choice ${id} must define at least one option`);
    }
    if (options.length === 1 && fallback !== options[0]) {
      throw new Error(`Single-option Choice ${id} must use its only option as fallback`);
    }
  }
  if (question.type === 'score') {
    if (!Array.isArray(question.criteria) || question.criteria.length < 2) {
      throw new Error(`Score ${id} must define at least two levels`);
    }
  }
}

function answerConfidence(answer) {
  if (answer?.type === 'noul') return Math.abs(Number(answer.noul) - 0.5) * 2;
  const confidence = answer?.confidence;
  return typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
    ? confidence : Number.NaN;
}

function validRemoteAnswer(question, answer) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer) || answer.type !== question.type) return false;
  if (question.type === 'choice') return Object.hasOwn(question.criteria, answer.choice)
    && Number.isFinite(answerConfidence(answer));
  if (question.type === 'score') return typeof answer.score === 'number' && Number.isFinite(answer.score)
    && answer.score >= 0 && answer.score <= question.criteria.length - 1
    && Number.isFinite(answerConfidence(answer));
  return typeof answer.noul === 'number' && Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1;
}

async function callProvider(config, state, questions, fetchImpl = globalThis.fetch) {
  if (!config.provider || !config.endpoint || !config.apiKey) {
    return { ok: false, code: 'provider_unavailable', retryable: false };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(config.endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ state, model: config.model, questions }),
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return {
        ok: false,
        code: `provider_http_${response.status}`,
        retryable: [429, 500, 502, 503, 504, 529].includes(response.status),
      };
    }
    const payload = await response.json();
    if (!payload || typeof payload.answers !== 'object' || payload.answers === null || Array.isArray(payload.answers)) {
      return { ok: false, code: 'provider_schema_invalid', retryable: false };
    }
    return {
      ok: true,
      answers: payload.answers,
      model: payload.model ?? config.model,
      usage: payload.usage ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      code: error?.name === 'AbortError' ? 'provider_timeout' : 'provider_transport_error',
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

export class JevSupervisor {
  constructor({ config = jevConfig(), receiptDirectory = null, fetchImpl = globalThis.fetch } = {}) {
    this.config = config;
    this.receiptDirectory = receiptDirectory;
    this.fetchImpl = fetchImpl;
    this.sequence = 0;
  }

  async evaluate({ decisionId, state, questions, fallbacks }) {
    if (!decisionId || !questions || !fallbacks) throw new Error('Jev evaluation requires decisionId, questions and fallbacks');
    for (const [id, question] of Object.entries(questions)) validateQuestion(id, question, fallbacks[id]);
    const fallbackAnswers = Object.fromEntries(Object.entries(questions).map(([id, question]) => [
      id,
      fallbackAnswer(question, fallbacks[id]),
    ]));
    const remotelyUseful = Object.values(questions).some(question => question.type !== 'choice' || Object.keys(question.criteria || {}).length > 1);
    const remote = !remotelyUseful
      ? { ok: false, code: 'deterministic_only', retryable: false }
      : this.config.mode === 'off'
      ? { ok: false, code: 'mode_off', retryable: false }
      : await callProvider(this.config, state, questions, this.fetchImpl);

    const adopted = {};
    const comparisons = {};
    for (const [id, question] of Object.entries(questions)) {
      const fallback = fallbackAnswers[id];
      const candidate = remote.ok && Object.hasOwn(remote.answers, id) ? remote.answers[id] : null;
      const valid = validRemoteAnswer(question, candidate);
      const confidence = valid ? answerConfidence(candidate) : 0;
      const eligible = valid && confidence >= this.config.confidenceFloor;
      const activeAdoption = this.config.mode === 'active' && eligible;
      adopted[id] = activeAdoption ? { ...candidate, source: 'jev_active' } : fallback;
      comparisons[id] = {
        fallback,
        remote: valid ? candidate : null,
        confidence,
        eligible,
        adoptedSource: adopted[id].source,
        differsFromFallback: valid && candidate[question.type] !== fallback[question.type],
      };
    }

    const receipt = {
      schemaVersion: 1,
      checkedAt: new Date().toISOString(),
      decisionId,
      mode: this.config.mode,
      provider: this.config.provider,
      model: remote.model ?? this.config.model,
      confidenceFloor: this.config.confidenceFloor,
      providerResult: remote.ok ? 'ok' : remote.code,
      comparisons,
      adopted,
      policy: {
        deterministicFallbackAlwaysAvailable: true,
        remoteMayChangeControlFlowOnlyInActiveMode: true,
        providerCredentialsPersisted: false,
      },
      usage: remote.ok ? remote.usage : null,
    };
    if (this.receiptDirectory) {
      await mkdir(this.receiptDirectory, { recursive: true });
      this.sequence += 1;
      const filename = `${String(this.sequence).padStart(2, '0')}-${decisionId}.json`;
      await writeFile(path.join(this.receiptDirectory, filename), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    }
    return receipt;
  }
}

export function choiceValue(receipt, id) {
  return receipt.adopted[id]?.choice ?? null;
}

export function scoreValue(receipt, id) {
  return Number(receipt.adopted[id]?.score ?? 0);
}

export function noulValue(receipt, id) {
  return Number(receipt.adopted[id]?.noul ?? 0);
}
