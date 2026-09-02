/**
 * The Gemini SDK client, and nothing else.
 *
 * This used to live inside services/aiService.js. Splitting it out is not
 * tidying for its own sake - it fixes a real coupling. services/embeddingService.js
 * needs the SAME client: the proxy agent, the base-URL override and the
 * timeout/retry policy were all worked out once, here, and a second client
 * would quietly have none of them. But importing it from aiService meant any
 * test that replaces aiService with a stub also broke search, which has
 * nothing to do with chat or summaries. Both now import the client from a
 * module that holds no opinions about prompts.
 */
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

// Kept even though app.js loads dotenv first: the standalone scripts
// (npm run ai:check / ai:net / search:index) import this module directly.
dotenv.config();

export const apiKey = (process.env.GEMINI_API_KEY || '').trim();
export const isAiConfigured = Boolean(apiKey);

/**
 * Corporate / university proxies.
 *
 * Node's built-in fetch does NOT read the system proxy settings, and before
 * Node 24 it does not read HTTP_PROXY/HTTPS_PROXY either. So on a campus or
 * office network where the browser reaches Google perfectly well, the server
 * gets a bare "fetch failed" - which is exactly the symptom that looks like
 * "no internet" while the internet is obviously working.
 *
 * If a proxy variable is set we route requests through it. `undici` is only
 * needed for this one case, so it is imported lazily and its absence is
 * explained rather than crashing the app.
 */
const proxyUrl =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || '';

export let proxyStatus = proxyUrl ? 'configured-not-applied' : 'none';

async function applyProxy() {
    if (!proxyUrl) return;
    try {
        const { ProxyAgent, setGlobalDispatcher } = await import('undici');
        setGlobalDispatcher(new ProxyAgent(proxyUrl));
        proxyStatus = 'applied';
        console.log(`[ai] Routing Gemini requests through the proxy at ${proxyUrl}`);
    } catch {
        proxyStatus = 'undici-missing';
        console.warn(
            `\n[ai] A proxy is set (${proxyUrl}) but Node's fetch cannot use it on its own.\n` +
            '[ai] Either install the helper:   npm install undici\n' +
            '[ai] or, on Node 24 or newer, start the server with NODE_USE_ENV_PROXY=1.\n'
        );
    }
}

// Kicked off at import; requests made before it settles simply go direct,
// which is the behaviour there was before.
const proxyReady = applyProxy();

let ai;
if (apiKey) {
    ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
            // Point the SDK somewhere other than Google. Left unset - the
            // normal case - it uses the real endpoint. Set it when the app
            // has to go through an API gateway, and in tests, so the whole
            // path (SDK -> error classifier -> route -> page) can be
            // exercised against a stand-in instead of the live service.
            ...(process.env.GEMINI_BASE_URL ? { baseUrl: process.env.GEMINI_BASE_URL } : {}),
            // CAREFUL - this is not only a client-side timeout.
            //
            // The SDK converts this into an `X-Server-Timeout` header (the
            // value in whole seconds), which tells GOOGLE how long it may
            // take. Google honours it: set it too low and the answer is
            //     504 DEADLINE_EXCEEDED
            //         "Deadline expired before operation could complete."
            // even though the key, the network and the model are all fine.
            // A 45-second value did exactly that to gemini-3.7-flash, which
            // spends time thinking before it replies.
            //
            // Two minutes is generous enough that Google is never the one
            // told to stop, while still bounding a request that has genuinely
            // hung (a proxy that accepts the connection and then says
            // nothing) instead of leaving the page spinning forever.
            timeout: parseInt(process.env.GEMINI_TIMEOUT_MS || '120000', 10),
            // DEADLINE_EXCEEDED and 503 are transient - the model was busy,
            // not wrong. Retrying with backoff turns most of them into an
            // answer instead of an error on screen.
            //
            // 429 is deliberately NOT in this list. A quota error is not
            // transient, and every retry spends another request from the
            // allowance - on a free tier of 20 requests per DAY, retrying
            // three times turns one question into 15% of the daily budget
            // and still fails. Including it here was a mistake.
            retryOptions: {
                // Two, not three. Each attempt is a request against a free
                // allowance of 20 per DAY, and when a model is overloaded the
                // useful move is to switch models (see modelCandidates), not
                // to keep asking the busy one. Two attempts still absorbs a
                // brief blip without spending the budget on a queue.
                attempts: parseInt(process.env.GEMINI_RETRY_ATTEMPTS || '2', 10),
                initialDelay: 1,
                maxDelay: 8,
                httpStatusCodes: [408, 500, 502, 503, 504],
            },
        },
    });
}


/** The configured SDK client, or undefined when there is no API key. */
export const geminiClient = () => ai;

/** Resolves once the proxy agent (if any) has been installed. */
export const clientReady = () => proxyReady;

export default { geminiClient, clientReady, apiKey, isAiConfigured };
