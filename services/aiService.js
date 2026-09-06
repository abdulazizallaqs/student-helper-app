import dotenv from 'dotenv';
import { apiKey, isAiConfigured, geminiClient, clientReady, proxyStatus } from './geminiClient.js';

// Kept even though app.js loads dotenv first: the standalone scripts
// (npm run ai:check / ai:net) import this module directly.
dotenv.config();

// The SDK client itself now lives in services/geminiClient.js - see the note
// at the top of that file for why. Re-exported here so this module's public
// surface is exactly what it was for the routes and scripts that use it.
export { isAiConfigured, geminiClient, clientReady, proxyStatus };

const ai = geminiClient();

// Model to use.
//
// Default is gemini-3.7-flash - the current Flash model. The previous default,
// gemini-2.5-flash, has an announced shutdown, and a retired ID answers 404
// NOT_FOUND, which used to surface in this app as a blank "AI Error".
// Note the ID uses DOTS: "gemini-3.7-flash". The all-dashes spelling
// "gemini-3-7-flash" appears in Google's documentation URLs but is not a
// valid model parameter.
//
// Still configurable, and if the configured model is gone resolveWorkingModel()
// below adopts a live one from the account's own model list rather than
// guessing a replacement name.
const CONFIGURED_MODEL = process.env.GEMINI_MODEL || 'gemini-3.7-flash';
//
/**
 * Per-request config.
 *
 * Gemini 3.x dropped several knobs that 2.x accepted: `temperature`, `topP`,
 * `topK` and `candidateCount` are not supported and are rejected. This app
 * never set any of them, so the move needed no changes there - but nothing
 * should start sending them either.
 *
 * What 3.x adds is `thinkingLevel` ('low' | 'medium' | 'high'), which replaces
 * the old numeric `thinkingBudget`.
 *
 * This app defaults it to 'low', NOT to Google's 'medium'. A thinking model
 * deliberates before it answers, and at 'medium' a plain chat question was
 * taking long enough to come back as
 *     504 DEADLINE_EXCEEDED - "Deadline expired before operation could complete"
 * Nothing here needs deep reasoning: a chat reply, a summary of one document,
 * ten flashcards. 'low' is markedly faster and cheaper for exactly this kind
 * of short, factual work. Set GEMINI_THINKING_LEVEL=medium (or high) to trade
 * that back for more deliberation.
 *
 * Only ever sent to 3.x models - it is not a valid parameter on 2.x, and
 * someone may still pin GEMINI_MODEL to an older id.
 */
const THINKING_LEVEL = (process.env.GEMINI_THINKING_LEVEL || 'low').trim().toLowerCase();
const VALID_THINKING_LEVELS = new Set(['low', 'medium', 'high']);

if (THINKING_LEVEL && !VALID_THINKING_LEVELS.has(THINKING_LEVEL)) {
    console.warn(
        `[ai] GEMINI_THINKING_LEVEL="${THINKING_LEVEL}" is not one of low|medium|high - ignoring it.`
    );
}

/** Build the `config` for a request, or undefined when there is nothing to send. */
export function requestConfig(model) {
    const isGemini3OrLater = /^gemini-(?:[3-9]|\d{2,})\./.test(model);
    if (!isGemini3OrLater) return undefined;
    if (!VALID_THINKING_LEVELS.has(THINKING_LEVEL)) return undefined;
    return { thinkingLevel: THINKING_LEVEL };
}

/**
 * Both Gemini API key formats.
 *   AIza...  - the original 39-character Standard key.
 *   AQ.Ab... - the Auth key format Google AI Studio issues now. These are
 *              valid on the native generativelanguage endpoint (which is what
 *              this SDK calls); they are only rejected by OpenAI-compatible
 *              adapters, which this app does not use.
 * Anything else is almost certainly the wrong value pasted into .env - an
 * OAuth client id, a project number, a service-account token.
 */
export function describeApiKey(key = apiKey) {
    if (!key) return { ok: false, kind: 'missing', message: 'GEMINI_API_KEY is not set in .env.' };
    if (/\s/.test(key)) return { ok: false, kind: 'whitespace', message: 'GEMINI_API_KEY contains a space or line break - re-copy it.' };
    if (/^["'].*["']$/.test(key)) return { ok: false, kind: 'quoted', message: 'GEMINI_API_KEY is wrapped in quotes - remove them.' };
    if (/^AIza[0-9A-Za-z_-]{35}$/.test(key)) return { ok: true, kind: 'standard', message: 'Standard key (AIza…).' };
    if (/^AQ\.[0-9A-Za-z_-]{10,}$/.test(key)) return { ok: true, kind: 'auth', message: 'Auth key (AQ.…), the format AI Studio issues now.' };
    if (/^ya29\./.test(key)) return { ok: false, kind: 'oauth', message: 'That is an OAuth access token (ya29.…), not an API key.' };
    if (/\.apps\.googleusercontent\.com$/.test(key)) return { ok: false, kind: 'clientid', message: 'That is an OAuth client ID, not a Gemini API key.' };
    return { ok: false, kind: 'unknown', message: `Does not look like a Gemini API key (starts "${key.slice(0, 4)}…", ${key.length} chars). Expected AIza… or AQ.….` };
}

/**
 * Flatten an error and everything in its `cause` chain into one description.
 *
 * THIS IS THE BUG THAT MADE "Could not reach Google" USELESS.
 *
 * Node's global fetch (undici) reports every transport failure as the same
 * two words: `TypeError: fetch failed`. The reason it failed - DNS could not
 * resolve the host, the TCP connection was refused, the TLS certificate did
 * not verify, a proxy timed out - lives in `error.cause`, and sometimes in
 * `error.cause.cause`. The old code only read `error.message`, so all of
 * those collapsed into one generic sentence with nothing to act on.
 *
 * Walking the chain recovers the `code` (ENOTFOUND, ECONNREFUSED,
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE, ...) that says which layer actually broke.
 */
export function describeError(error) {
    const parts = [];
    const codes = [];
    let current = error;
    let depth = 0;

    while (current && depth < 6) {
        const message = current.message || String(current);
        const code = current.code || current.errno;
        if (code) codes.push(String(code));

        const extras = [
            current.syscall && `syscall=${current.syscall}`,
            current.hostname && `host=${current.hostname}`,
            current.address && `address=${current.address}`,
            current.port && `port=${current.port}`,
        ].filter(Boolean).join(' ');

        parts.push([code ? `[${code}]` : '', message, extras].filter(Boolean).join(' ').trim());

        current = current.cause;
        depth += 1;
    }

    return {
        text: parts.join('  <-  '),
        codes,
        status: error?.status ?? (typeof error?.code === 'number' ? error.code : null),
    };
}

/** Network-layer failure codes, grouped by what the user has to do about them. */
const DNS_CODES = ['ENOTFOUND', 'EAI_AGAIN'];
const REFUSED_CODES = ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_SOCKET'];
const TIMEOUT_CODES = ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ABORT_ERR'];
const TLS_CODES = [
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT',
    'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
];

const HOST = 'generativelanguage.googleapis.com';

/**
 * The most informative single line of an error, short enough to put in a
 * user-facing message. Google returns a JSON body; its `error.message` is the
 * sentence worth showing.
 */
export function firstUsefulLine(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';

    // Google's errors arrive as a JSON body, sometimes wrapped in other text.
    const jsonStart = text.indexOf('{');
    if (jsonStart !== -1) {
        try {
            const parsed = JSON.parse(text.slice(jsonStart, text.lastIndexOf('}') + 1));
            const message = parsed?.error?.message || parsed?.message;
            if (message) return String(message).slice(0, 300);
        } catch { /* not JSON after all - fall through */ }
    }
    return text.split('  <-  ')[0].slice(0, 300);
}


/**
 * Quota circuit breaker.
 *
 * The free tier allows a small number of requests per DAY (this project's key
 * reports 20 for gemini-3.7-flash). Once that is spent, every further call
 * still travels to Google, still waits, and still fails - so a student
 * clicking around gets slow errors on every page for the rest of the day, and
 * any per-minute allowance is burned too.
 *
 * When Google reports a quota failure the details are remembered and further
 * calls are refused locally, instantly, with a message that says when to come
 * back. Background features (recommendations, upload keywords) check this
 * first and skip silently rather than queueing up doomed requests.
 */
/**
 * Quota is PER MODEL, so the block is too.
 *
 * The quota id Google returns is
 *     GenerateRequestsPerDayPerProjectPerModel-FreeTier
 * - "PerModel". Spending the 20 daily requests on gemini-3.7-flash says
 * nothing about gemini-3.1-flash-lite, which has its own separate allowance.
 * The first version of this treated one model's exhausted quota as "the AI is
 * out of quota" and refused everything for ten minutes, which is why five
 * attempts in a row all came back instantly with a cached message.
 *
 * Now a model that runs out is set aside individually and the request goes to
 * the next one, exactly as it does for an overloaded model.
 */
const quotaBlocks = new Map(); // model -> { until, strikes, summary }

/** Seconds from a Google `retryDelay` such as "32s" or "32.4366s". */
function parseRetryDelay(value) {
    const match = /([\d.]+)s/.exec(String(value || ''));
    return match ? Math.ceil(parseFloat(match[1])) : 0;
}

/**
 * Pull the useful parts out of a RESOURCE_EXHAUSTED body: which quota, which
 * model, how big it is, and how long Google suggests waiting.
 */
function readQuotaFailure(raw) {
    const out = { perDay: false, limit: null, model: null, retryAfter: 0 };
    const jsonStart = String(raw).indexOf('{');
    if (jsonStart === -1) return out;

    try {
        const parsed = JSON.parse(String(raw).slice(jsonStart, String(raw).lastIndexOf('}') + 1));
        const details = parsed?.error?.details || [];

        for (const detail of details) {
            const type = String(detail['@type'] || '');
            if (type.endsWith('QuotaFailure')) {
                const violation = (detail.violations || [])[0] || {};
                out.perDay = /PerDay/i.test(violation.quotaId || '');
                out.limit = violation.quotaValue ? Number(violation.quotaValue) : null;
                out.model = violation.quotaDimensions?.model || null;
            }
            if (type.endsWith('RetryInfo')) {
                out.retryAfter = parseRetryDelay(detail.retryDelay);
            }
        }
        if (!out.retryAfter) out.retryAfter = parseRetryDelay(parsed?.error?.message);
    } catch { /* not the shape we expected - the defaults are fine */ }

    return out;
}

/** Human wording for a wait in seconds. */
function humanWait(seconds) {
    if (seconds <= 0) return 'a moment';
    if (seconds < 90) return `about ${seconds} seconds`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
    return `about ${Math.round(minutes / 60)} hours`;
}

/** Is this specific model currently out of quota? */
function isQuotaBlocked(model) {
    const block = quotaBlocks.get(model);
    if (!block) return false;
    if (Date.now() >= block.until) {
        // The hold is over. Keep the strike count so a model that keeps
        // failing backs off further, but let it be tried again.
        quotaBlocks.set(model, { ...block, until: 0 });
        return false;
    }
    return true;
}

/** Models currently set aside for quota (for diagnostics). */
/**
 * Which language is this study material written in?
 *
 * WHY THIS EXISTS: the quiz and flashcard prompts said "in ARABIC", flatly,
 * with no reference to the source. So an English thermodynamics PDF came back
 * as Arabic questions about English text - answers a student could not match
 * to anything in their own notes, and terminology translated into words their
 * exam does not use.
 *
 * "Reply in the same language as the notes" alone is not enough. A model given
 * a short or mostly-numeric extract drifts to whatever language the rest of
 * the prompt is in, and the drift is silent. Deciding here and naming the
 * language in the prompt makes it deterministic - and testable without a
 * network call.
 *
 * Script counting, not word lists: Arabic and Latin occupy separate Unicode
 * blocks, so this needs no dictionary and is not fooled by a technical term
 * that exists in both languages. Digits, punctuation and whitespace are
 * ignored - a page of equations should not swing the answer.
 *
 * @param {string} text
 * @returns {'Arabic'|'English'} the language to write the output in
 */
export function detectLanguage(text) {
    const sample = String(text || '').slice(0, 4000);

    // ؀-ۿ Arabic, ݐ-ݿ Arabic Supplement,
    // ﭐ-﷿ and ﹰ-﻿ the presentation forms some PDFs emit.
    const arabic = (sample.match(/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g) || []).length;
    const latin = (sample.match(/[A-Za-z]/g) || []).length;

    // English is the default for a tie or for text with no letters at all
    // (a table of numbers, say): it is the safer wrong answer, because the
    // technical vocabulary in these files is usually English either way.
    return arabic > latin ? 'Arabic' : 'English';
}

export function quotaBlockedModels() {
    return [...quotaBlocks.keys()].filter(isQuotaBlocked);
}

/**
 * Note that a model ran out, and for how long to leave it alone.
 *
 * The wait ESCALATES rather than jumping straight to a long hold. Google's
 * suggested retryDelay is often under a minute even when it reports a daily
 * quota, so the first hold honours it - a per-minute limit then recovers in
 * under a minute. Only a model that keeps coming back exhausted is backed off
 * further, which is what a genuinely spent daily allowance looks like.
 */
function rememberQuotaFailure(raw, calledModel) {
    const info = readQuotaFailure(raw);
    // Block the model we actually called. Google names the same one in the
    // QuotaFailure details, but only the caller knows for certain which
    // request this was - and blocking the wrong model would leave the real
    // one being retried until its allowance is gone too.
    const model = calledModel || info.model;
    const previous = quotaBlocks.get(model);
    const strikes = (previous?.strikes || 0) + 1;

    // 1st: what Google suggested (min 30s). Then 2 min, 10 min, 30 min.
    const ladder = [Math.max(info.retryAfter, 30), 120, 600, 1800];
    const holdSeconds = ladder[Math.min(strikes - 1, ladder.length - 1)];

    const named = info.model || model;
    const summary = info.perDay && info.limit
        ? `the free daily limit for ${named} (${info.limit} requests per day) is used up`
        : info.limit
            ? `the rate limit for ${named} (${info.limit}) was hit`
            : `the Gemini quota for ${named} is used up`;

    quotaBlocks.set(model, { until: Date.now() + holdSeconds * 1000, strikes, summary });
    console.warn(`[ai] Quota exhausted for "${model}"; not using it for ${humanWait(holdSeconds)}.`);
    return quotaBlocks.get(model);
}

/**
 * The message shown when there is nothing left to try. Built at THROW time,
 * not at block time, so the countdown it quotes is the real remaining wait -
 * the old version cached a sentence saying "retry in 44 seconds" and then
 * repeated it for ten minutes.
 */
function quotaMessageFor(models) {
    const blocked = models.map((m) => quotaBlocks.get(m)).filter(Boolean);
    const soonest = blocked.reduce((best, b) => (!best || b.until < best.until ? b : best), null);
    const waitSeconds = soonest ? Math.max(0, Math.ceil((soonest.until - Date.now()) / 1000)) : 0;

    const what = blocked.length === 1
        ? blocked[0].summary
        : `every model this app can use is out of quota (${models.join(', ')})`;

    return `AI is paused: ${what}. Trying again in ${humanWait(waitSeconds)}. ` +
        'Check your usage at https://ai.dev/rate-limit, set GEMINI_MODEL to a model with a larger free ' +
        'allowance, or enable billing on the key\'s project.';
}

/**
 * An AI failure the caller can act on. `status` is the HTTP status the API
 * route should answer with, `message` is safe to show the user.
 *
 * Before this, every failure was swallowed: aiService returned a friendly
 * sentence ("Sorry, I encountered an error…") and the routes answered
 * `{error:'AI Error'}` with a 500. A wrong key, an exhausted quota, a retired
 * model and a network outage were therefore indistinguishable from each other
 * and from the model simply declining - which is why "the AI does not work"
 * could not be diagnosed from the app at all.
 */
export class AiError extends Error {
    constructor(message, { status = 502, code = 'ai_error', detail = '' } = {}) {
        super(message);
        this.name = 'AiError';
        this.status = status;
        this.code = code;
        this.detail = detail;
    }
}

/**
 * Turn whatever the SDK threw into an AiError with a status, a code and a
 * message the person running the app can act on.
 *
 * Network problems are separated by LAYER, because the fix is different for
 * each and "check your internet connection" is useless when the internet is
 * plainly working: DNS, a refused connection, a timeout and a rejected TLS
 * certificate each get their own explanation.
 */
function interpret(error) {
    const described = describeError(error);
    const raw = described.text;
    const text = raw.toLowerCase();
    const codes = described.codes;
    const status = described.status;
    const has = (list) => codes.some((c) => list.includes(c));

    // --- transport, before anything else. A request that never reached
    // Google cannot tell us anything about the key or the model. -----------
    if (has(TLS_CODES) || text.includes('certificate') || text.includes('self-signed')) {
        return new AiError(
            `The HTTPS connection to ${HOST} was rejected because its certificate could not be verified. ` +
            'That is almost always antivirus or a company/university proxy inspecting HTTPS traffic - ' +
            'the API key is fine. Run "npm run ai:net" - it names the step that fails.',
            { status: 504, code: 'tls', detail: raw });
    }
    if (has(DNS_CODES)) {
        return new AiError(
            `This machine could not resolve ${HOST} (DNS). Check the internet connection, VPN or DNS settings. ` +
            'The API key is fine - the request never left the machine.',
            { status: 504, code: 'dns', detail: raw });
    }
    if (has(TIMEOUT_CODES)) {
        return new AiError(
            `The connection to ${HOST} timed out. A firewall or proxy is most likely dropping it silently. ` +
            'Run "npm run ai:net" - it tests each step separately.',
            { status: 504, code: 'timeout', detail: raw });
    }
    if (has(REFUSED_CODES)) {
        return new AiError(
            `The connection to ${HOST} was refused or cut. A firewall, proxy or network policy is blocking it. ` +
            'Run "npm run ai:net" - it names the step that fails.',
            { status: 504, code: 'blocked', detail: raw });
    }

    // An allowlist/proxy rejection often arrives as a normal 403 body.
    if (text.includes('not in allowlist') || text.includes('egress') ||
        text.includes('proxy') || text.includes('blocked by') || text.includes('tunnel')) {
        return new AiError(
            `This machine is not allowed to reach ${HOST}. A firewall, proxy or network allowlist is blocking it - ` +
            'the API key is probably fine.',
            { status: 504, code: 'network', detail: raw });
    }

    // `fetch failed` with no recognisable cause: still a transport failure,
    // but say so honestly rather than guessing at the reason.
    if (text.includes('fetch failed') || text.includes('failed to fetch')) {
        return new AiError(
            `The request to ${HOST} failed before Google answered. Run "npm run ai:net" - it tests DNS, ` +
            'the connection and the certificate separately and names the step that fails.',
            { status: 504, code: 'network', detail: raw });
    }

    // --- Google answered; now it is about the key, the quota or the model --
    if (text.includes('api key not valid') || text.includes('api_key_invalid') ||
        (status === 400 && text.includes('api key'))) {
        return new AiError('The Gemini API key was rejected. Check GEMINI_API_KEY in .env, then restart the server.',
            { status: 502, code: 'bad_key', detail: raw });
    }
    if (status === 401 || status === 403 || text.includes('permission_denied') || text.includes('unauthorized')) {
        return new AiError('Google refused this API key. It may be restricted, disabled, or the Generative Language API may not be enabled for its project.',
            { status: 502, code: 'forbidden', detail: raw });
    }
    if (status === 429 || text.includes('resource_exhausted') || text.includes('quota')) {
        // Records how long to stay off the API, and builds a message from the
        // QuotaFailure/RetryInfo details Google actually sent - which quota,
        // how big it is, when to come back - rather than a generic sentence.
        // Deliberately no side effect here: interpret() does not know which
        // model was called (generate() may walk several), and it is also used
        // by listAvailableModels. The caller records the block against the
        // model it actually used.
        return new AiError('Quota exhausted for this model.', { status: 429, code: 'quota', detail: raw });
    }
    if (status === 404 || text.includes('not_found') || text.includes('no longer available')) {
        return new AiError(`The model "${activeModel}" is not available to this key. Set GEMINI_MODEL in .env to one that is - "npm run ai:check" lists them.`,
            { status: 502, code: 'model', detail: raw });
    }
    // Google answered - it just could not finish in the time it was allowed.
    // This is NOT a connectivity problem: the key worked, the model exists,
    // the request arrived. Kept well away from the transport cases above so
    // it never gets reported as "check your internet connection".
    if (status === 504 || text.includes('deadline_exceeded') || text.includes('deadline expired')) {
        return new AiError(
            'The model took too long and Google gave up on the request. It reached Google fine - the API key ' +
            'and the network are working. Try again; if it keeps happening, lower the work per request ' +
            '(GEMINI_THINKING_LEVEL=low) or raise the deadline (GEMINI_TIMEOUT_MS).',
            { status: 504, code: 'deadline', detail: raw });
    }
    if (status === 500 || status === 503 || text.includes('unavailable') || text.includes('overloaded')) {
        return new AiError('Google\'s service is temporarily unavailable or overloaded. Try again in a moment.',
            { status: 503, code: 'upstream', detail: raw });
    }
    // Any other 400: Google understood the request and refused it. The body
    // says why ("Invalid JSON payload", an unsupported field, a content
    // filter), and that body is the only thing that identifies the problem -
    // so it goes in the message, not just the log.
    if (status === 400 || text.includes('invalid_argument') || text.includes('failed_precondition')) {
        return new AiError(`Google rejected the request (HTTP 400). ${firstUsefulLine(raw)}`,
            { status: 502, code: 'bad_request', detail: raw });
    }
    // Genuinely unrecognised. Say the status and the first line of what came
    // back rather than "the AI service returned an error", which tells the
    // person nothing they can act on.
    return new AiError(
        `The AI service returned an error${status ? ` (HTTP ${status})` : ''}. ${firstUsefulLine(raw)}`,
        { status: 502, code: 'ai_error', detail: raw });
}

/**
 * The model this process is actually using.
 *
 * Starts as the configured one. If Google says it does not exist (a retired
 * ID), the account's own model list is queried once and the first model that
 * supports generateContent is adopted, with a loud log line. That is better
 * than hardcoding a "newer" name, which would just become wrong again on the
 * next retirement.
 */
let activeModel = CONFIGURED_MODEL;
let modelResolution = null;

/** Model IDs this key can call. */
export async function listAvailableModels() {
    if (!ai) throw new AiError('AI is not configured.', { status: 503, code: 'unconfigured' });
    await clientReady();
    try {
        const page = await ai.models.list();
        const names = [];
        for await (const model of page) {
            const id = String(model.name || '').replace(/^models\//, '');
            const actions = model.supportedActions || model.supportedGenerationMethods || [];
            if (!id) continue;
            if (actions.length === 0 || actions.includes('generateContent')) names.push(id);
        }
        return names;
    } catch (error) {
        throw interpret(error);
    }
}

async function resolveWorkingModel() {
    if (!modelResolution) {
        modelResolution = (async () => {
            const models = await listAvailableModels();
            // Prefer a flash-class text model: the same cost/latency profile
            // the app was built around.
            const usable = (m) => !/image|audio|live|tts|embed|vision|robotics/.test(m);
            const preferred =
                // Newest flash-class text model first: sort descending so
                // gemini-3.7-flash wins over gemini-3.1-flash.
                models.filter((m) => /flash/.test(m) && usable(m)).sort().reverse()[0] ||
                models.filter(usable).sort().reverse()[0] ||
                models[0];
            if (!preferred) {
                throw new AiError('This API key has no models that can generate text.',
                    { status: 502, code: 'model' });
            }
            console.warn(
                '\n[ai] The configured model "' + CONFIGURED_MODEL + '" is not available to this key.\n' +
                '[ai] Falling back to "' + preferred + '" for this run.\n' +
                '[ai] Set GEMINI_MODEL=' + preferred + ' in .env to make it permanent.\n'
            );
            activeModel = preferred;
            return preferred;
        })().catch((error) => {
            modelResolution = null; // a transient failure shouldn't be cached
            throw error;
        });
    }
    return modelResolution;
}

/**
 * Overload handling.
 *
 * A 503 "This model is currently experiencing high demand" is Google's
 * capacity, not a fault in this app - and the newest model attracts the most
 * of it, so pinning everything to one brand-new model means the assistant is
 * down whenever that model happens to be busy.
 *
 * When a model reports itself overloaded it is set aside for a few minutes
 * and the request is sent to an alternate instead. That turns "try again
 * later" into an answer, usually without the student noticing.
 *
 * Deliberately bounded: every attempt spends one request from the daily
 * allowance (20/day on the free tier), so at most GEMINI_MODEL_ATTEMPTS
 * models are tried per question.
 */
const CONGESTION_HOLD_MS = parseInt(process.env.GEMINI_CONGESTION_HOLD_MS || '180000', 10);
const MAX_MODEL_ATTEMPTS = Math.max(1, parseInt(process.env.GEMINI_MODEL_ATTEMPTS || '2', 10));

/** Explicit alternates, most preferred first. */
const CONFIGURED_FALLBACKS = (process.env.GEMINI_FALLBACK_MODELS || '')
    .split(',').map((m) => m.trim()).filter(Boolean);

const congestedUntil = new Map();
let discoveredAlternates = null;

function markCongested(model) {
    congestedUntil.set(model, Date.now() + CONGESTION_HOLD_MS);
    console.warn(`[ai] "${model}" is overloaded; preferring another model for the next ` +
        `${Math.round(CONGESTION_HOLD_MS / 60000)} minutes.`);
}

function isCongested(model) {
    const until = congestedUntil.get(model);
    if (!until) return false;
    if (Date.now() >= until) {
        congestedUntil.delete(model);
        return false;
    }
    return true;
}

/** Which models are currently set aside as busy (for diagnostics). */
export function congestedModels() {
    return [...congestedUntil.keys()].filter(isCongested);
}

/**
 * Alternates taken from the key's own model list - never a guessed name, and
 * asked for only once. models.list is a different endpoint from
 * generateContent, so this does not consume the generation allowance.
 */
async function alternateModels(primary) {
    if (CONFIGURED_FALLBACKS.length) return CONFIGURED_FALLBACKS.filter((m) => m !== primary);
    if (discoveredAlternates) return discoveredAlternates;

    try {
        const usable = (m) => !/image|audio|live|tts|embed|vision|robotics/.test(m);
        const models = (await listAvailableModels()).filter(usable);
        discoveredAlternates = models
            .filter((m) => /flash|lite/.test(m) && m !== primary)
            // Newest first, so a 3.x alternate is preferred over a 2.x one.
            .sort().reverse()
            .slice(0, 3);
    } catch {
        // Cannot list them: carry on with the primary alone rather than fail.
        discoveredAlternates = [];
    }
    return discoveredAlternates;
}

/**
 * The models worth trying, best first.
 *
 * A model that is out of quota is skipped entirely - skipping costs nothing,
 * whereas calling it spends a request to be told what we already know. A
 * model that is merely congested is demoted rather than dropped, since
 * congestion clears unpredictably.
 *
 * Returns { candidates, allBlocked } so the caller can tell "nothing to try"
 * apart from "tried and failed".
 */
async function modelCandidates() {
    const primary = activeModel;
    const ordered = [primary, ...(await alternateModels(primary))]
        .filter((m, i, all) => m && all.indexOf(m) === i);

    const available = ordered.filter((m) => !isQuotaBlocked(m));
    if (available.length === 0) {
        return { candidates: [], allBlocked: ordered };
    }

    const fresh = available.filter((m) => !isCongested(m));
    const busy = available.filter((m) => isCongested(m));
    return {
        candidates: (fresh.length ? [...fresh, ...busy] : available).slice(0, MAX_MODEL_ATTEMPTS),
        allBlocked: [],
    };
}

/**
 * Ask the model, moving to an alternate when one is retired or overloaded.
 * Throws AiError; never returns an apology string pretending to be an answer.
 */
async function generate(contents) {
    if (!ai) {
        throw new AiError('AI features are switched off because GEMINI_API_KEY is not set in .env.',
            { status: 503, code: 'unconfigured' });
    }

    // Make sure a configured proxy is installed before the first request.
    await clientReady();

    const { candidates, allBlocked } = await modelCandidates();

    // Every model this app can reach is out of quota. Say so with the real
    // remaining wait rather than a sentence captured minutes ago.
    if (candidates.length === 0) {
        throw new AiError(quotaMessageFor(allBlocked),
            { status: 429, code: 'quota', detail: `all models out of quota: ${allBlocked.join(', ')}` });
    }

    const attempted = [];
    let lastProblem = null;

    for (const model of candidates) {
        attempted.push(model);
        try {
            const result = await ai.models.generateContent({
                model, contents, config: requestConfig(model)
            });
            if (model !== activeModel) {
                console.log(`[ai] Answered with the fallback model "${model}".`);
            }
            return result.text ?? '';
        } catch (error) {
            const problem = interpret(error);
            lastProblem = problem;

            if (problem.code === 'upstream') {
                // Overloaded. Another model may well be free right now, so
                // move on instead of reporting "try again later".
                markCongested(model);
                continue;
            }

            if (problem.code === 'quota') {
                rememberQuotaFailure(problem.detail, model);
                // Quota is per model - the next one has its own allowance, so
                // this is worth trying rather than giving up. Only a model
                // that has not itself been exhausted is added.
                const next = (await alternateModels(activeModel))
                    .find((m) => !attempted.includes(m) && !isQuotaBlocked(m));
                if (next) {
                    candidates.push(next);
                    continue;
                }
                throw new AiError(quotaMessageFor(attempted),
                    { status: 429, code: 'quota', detail: problem.detail });
            }

            if (problem.code === 'model') {
                // Retired id. Adopt a live one and let the loop try it.
                const replacement = await resolveWorkingModel();
                if (!attempted.includes(replacement)) candidates.push(replacement);
                continue;
            }

            // A rejected key or a blocked network: another model cannot help,
            // and would only spend more of the allowance.
            throw problem;
        }
    }

    if (lastProblem?.code === 'upstream' && attempted.length > 1) {
        throw new AiError(
            `Google is busy: ${attempted.map((m) => `"${m}"`).join(' and ')} both reported high demand. ` +
            'That is capacity on Google\'s side, not a problem with your key or this app. Try again shortly.',
            { status: 503, code: 'upstream', detail: lastProblem.detail });
    }
    throw lastProblem ?? new AiError('The AI service did not answer.', { status: 502, code: 'ai_error' });
}

/** Which model this process ended up using (for diagnostics). */
export const activeModelName = () => activeModel;

/**
 * Strip markdown code fences and parse a JSON response from the model.
 * Returns null on failure so callers can handle it gracefully.
 */
function parseJsonResponse(text) {
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    try {
        return JSON.parse(cleaned);
    } catch (error) {
        console.error('AI JSON Parse Error:', error, 'Raw:', cleaned.slice(0, 300));
        return null;
    }
}

// Recommendations are the same for everyone (the "interests" passed in are a
// fixed string), so one answer serves every dashboard load for hours.
const RECOMMENDATION_TTL_MS = parseInt(process.env.GEMINI_RECOMMEND_TTL_MS || String(6 * 60 * 60 * 1000), 10);
const recommendationCache = new Map();

const aiService = {
    /**
     * Generate a response for the chat interface.
     *
     * Returns PLAIN TEXT. It used to be markdown-rendered to HTML by the
     * route while the page inserted it with textContent - so every reply
     * arrived on screen as literal markup: "<p>Here is the answer</p>".
     * @param {Array} history - [{role:'user'|'model', message:string}]
     * @param {string} message - Current user message
     * @returns {Promise<string>}
     */
    generateChatResponse: async (history, message) => {
        // Built as a plain "contents" array (history + the new turn) rather
        // than the SDK's stateful chat-session helper, since that's the one
        // request shape that's stayed stable across every version of the
        // Gemini API and both SDK generations.
        const contents = [
            ...(history || []).map((msg) => ({
                role: msg.role === 'user' ? 'user' : 'model',
                parts: [{ text: String(msg.message ?? '') }]
            })).filter((turn) => turn.parts[0].text !== ''),
            { role: 'user', parts: [{ text: message }] }
        ];
        return generate(contents);
    },

    /**
     * Summarize provided text (from PDF notes). Plain text - see above.
     * @param {string} text
     * @returns {Promise<string>}
     */
    summarizeText: async (text) => {
        // Naming the language beats "the same language as the notes": on a
        // short or mostly-numeric extract the model drifts to whatever
        // language the rest of the prompt is written in, and does it quietly.
        const language = detectLanguage(text);
        const prompt =
            'Summarize the following study notes concisely and helpfully. ' +
            `Write the summary in ${language} - the language the notes themselves use. ` +
            'Use plain text with short paragraphs - no markdown, no asterisks, no headings.\n\n' +
            text.substring(0, 30000);
        return generate(prompt);
    },

    /**
     * Generate keywords for a file to improve search.
     * Non-fatal by design: this runs in the background during an upload, and
     * a failure must never fail the upload itself.
     * @param {string} text
     * @returns {Promise<string>} Space-separated keywords, '' on failure
     */
    generateKeywords: async (text) => {
        // Runs in the background on every PDF upload. Worth skipping outright
        // when the allowance is gone - the upload itself must not be delayed
        // by a request that is going to fail.
        if (isQuotaBlocked(activeModel)) return '';
        try {
            const prompt =
                'Generate 5-10 specific search keywords for the following text. ' +
                'Return ONLY the keywords separated by spaces. No other text.\n\n' +
                text.substring(0, 10000);
            return await generate(prompt);
        } catch (error) {
            console.error('[ai] Keyword generation skipped:', error.message);
            return '';
        }
    },

    /**
     * Content recommendations for the dashboard.
     *
     * CACHED, and that matters a great deal on the free tier.
     *
     * This fires from the signed-in landing page on every single page load, and the
     * interests it is given are a fixed string, so it was asking the model
     * the same question over and over for the same answer. With a free
     * allowance of 20 requests per DAY, twenty visits to the dashboard - not
     * twenty questions, twenty page loads - spent the entire budget before
     * the student asked the assistant anything.
     *
     * The answer is now computed once and reused, so the dashboard costs at
     * most a handful of requests a day instead of one per visit.
     *
     * Non-fatal either way: the dashboard must still load when the AI is
     * unavailable.
     *
     * @param {string} userInterests
     * @returns {Promise<string>} JSON string of recommendations, '[]' on failure
     */
    getRecommendations: async (userInterests) => {
        const cached = recommendationCache.get(userInterests);
        if (cached && cached.expires > Date.now()) return cached.value;

        // Out of quota: serve whatever was cached earlier rather than
        // spending a request that will fail.
        if (isQuotaBlocked(activeModel)) return cached ? cached.value : '[]';

        try {
            const prompt =
                'Based on these interests: "' + userInterests + '", suggest 3 study topics or ' +
                'related subjects. Return the result as a JSON array of strings.';
            const text = await generate(prompt);
            const value = text.replace(/```json/g, '').replace(/```/g, '').trim();
            recommendationCache.set(userInterests, { value, expires: Date.now() + RECOMMENDATION_TTL_MS });
            return value;
        } catch (error) {
            console.error('[ai] Recommendations skipped:', error.message);
            // Cache the failure briefly too, so a page that reloads in a loop
            // cannot turn one outage into a hundred requests.
            recommendationCache.set(userInterests, { value: '[]', expires: Date.now() + 60000 });
            return '[]';
        }
    },

    /**
     * Generate a multiple-choice quiz from study material.
     * @param {string} text - Source text (e.g. extracted from an uploaded PDF)
     * @param {number} count - Number of questions to generate
     * @returns {Promise<Array<{question:string, options:string[], correctIndex:number}>>}
     */
    generateQuiz: async (text, count = 5) => {
        const language = detectLanguage(text);
        const prompt = `You are creating a study quiz from the notes below. Generate exactly ${count} multiple-choice questions, each with 4 options and exactly one correct answer. Base every question strictly on the provided text - do not invent facts that aren't in it.

Write the questions and every option in ${language}. These notes are written in ${language}, and a student revising from them needs the quiz in the same words and the same terminology - not a translation of their own material.

Return ONLY valid JSON, no markdown fences, no extra text, in this exact shape:
[{"question": "...", "options": ["...", "...", "...", "..."], "correctIndex": 0}]

Notes:
${text.substring(0, 25000)}`;
        const parsed = parseJsonResponse(await generate(prompt));
        if (!Array.isArray(parsed)) {
            throw new AiError('The model did not return a usable quiz. Please try again.',
                { status: 502, code: 'bad_output' });
        }
        return parsed;
    },

    /**
     * Generate flashcards (front/back pairs) from study material.
     * @param {string} text
     * @param {number} count
     * @returns {Promise<Array<{front:string, back:string}>>}
     */
    generateFlashcards: async (text, count = 10) => {
        const language = detectLanguage(text);
        const prompt = `You are creating study flashcards from the notes below. Generate exactly ${count} flashcards covering the most important concepts. Each flashcard has a short "front" (a term or question) and a concise "back" (the answer or definition), based strictly on the provided text.

Write both sides of every card in ${language}, the language these notes are written in.

Return ONLY valid JSON, no markdown fences, no extra text, in this exact shape:
[{"front": "...", "back": "..."}]

Notes:
${text.substring(0, 25000)}`;
        const parsed = parseJsonResponse(await generate(prompt));
        if (!Array.isArray(parsed)) {
            throw new AiError('The model did not return usable flashcards. Please try again.',
                { status: 502, code: 'bad_output' });
        }
        return parsed;
    },

    /**
     * One real end-to-end call, for `npm run ai:check` and `npm run diagnose`.
     * @returns {Promise<{ok:boolean, model:string, reply?:string, error?:AiError}>}
     */
    selfTest: async () => {
        try {
            const reply = await generate('Reply with exactly the word: OK');
            return { ok: true, model: activeModel, reply: (reply || '').trim().slice(0, 40) };
        } catch (error) {
            return { ok: false, model: activeModel, error };
        }
    }
};

export default aiService;
