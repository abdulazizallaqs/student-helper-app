// Unit tests for services/aiService.js. aiService reads GEMINI_API_KEY and
// constructs its client at MODULE LOAD time, so each scenario stubs the env
// var, resets the module registry, and re-imports the module fresh - no real
// network call ever happens in this file.
//
// The contract changed deliberately: these functions used to swallow every
// failure and return a friendly sentence ("Sorry, I encountered an error…")
// or an {error} object, which made a rejected API key, an exhausted quota, a
// retired model and a dead network all look identical to the caller - and to
// the user, who saw only the words "AI Error". They now throw AiError with a
// status, a machine-readable code and a message that says what to do.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('@google/genai');
});

function mockSdk(generateContent, list) {
  vi.doMock('@google/genai', () => ({
    // A real constructor, not an arrow function: the SDK is used as
    // `new GoogleGenAI(...)`, and Vitest forwards `new` to the implementation
    // it was given - an arrow function cannot be constructed.
    GoogleGenAI: vi.fn(function GoogleGenAIMock() {
      this.models = { generateContent, list: list || vi.fn() };
    }),
  }));
}

describe('describeApiKey', () => {
  it('accepts both key formats Google issues', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'x');
    const { describeApiKey } = await import('../../services/aiService.js');

    // The original 39-character standard key.
    expect(describeApiKey('AIza' + 'a'.repeat(35)).ok).toBe(true);
    // The newer AI Studio "auth key" - valid on the native endpoint this SDK
    // uses, and the format a fresh key comes out as today.
    expect(describeApiKey('AQ.Ab8RN6J' + 'b'.repeat(30)).ok).toBe(true);
  });

  it('rejects the values people paste in by mistake', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'x');
    const { describeApiKey } = await import('../../services/aiService.js');

    expect(describeApiKey('').kind).toBe('missing');
    expect(describeApiKey('ya29.a0Af').kind).toBe('oauth');
    expect(describeApiKey('12345.apps.googleusercontent.com').kind).toBe('clientid');
    expect(describeApiKey('AIza abc').kind).toBe('whitespace');
    expect(describeApiKey('"AIzaSyABC"').kind).toBe('quoted');
  });
});

describe('aiService without a configured API key', () => {
  it('throws a clear, actionable error rather than pretending to answer', async () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    const { default: aiService, AiError } = await import('../../services/aiService.js');

    await expect(aiService.generateChatResponse([], 'hi')).rejects.toBeInstanceOf(AiError);
    await expect(aiService.summarizeText('notes')).rejects.toMatchObject({
      code: 'unconfigured',
      status: 503,
    });
    await expect(aiService.generateQuiz('notes')).rejects.toMatchObject({ code: 'unconfigured' });
    await expect(aiService.generateFlashcards('notes')).rejects.toMatchObject({ code: 'unconfigured' });
  });

  it('still degrades quietly for the two background features', async () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    const { default: aiService } = await import('../../services/aiService.js');

    // These decorate an upload and the dashboard; neither may fail the page.
    await expect(aiService.generateKeywords('notes')).resolves.toBe('');
    await expect(aiService.getRecommendations('math')).resolves.toBe('[]');
  });
});

describe('aiService with a configured API key (SDK mocked, no real network call)', () => {
  it('parses a fenced JSON quiz response into an array', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    const generateContent = vi.fn().mockResolvedValue({
      text: '```json\n[{"question":"2+2?","options":["3","4","5","6"],"correctIndex":1}]\n```',
    });
    mockSdk(generateContent);

    const { default: aiService } = await import('../../services/aiService.js');
    const quiz = await aiService.generateQuiz('2 + 2 equals 4.');

    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(quiz).toEqual([{ question: '2+2?', options: ['3', '4', '5', '6'], correctIndex: 1 }]);
  });

  it('reports unusable model output as bad_output', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    mockSdk(vi.fn().mockResolvedValue({ text: 'not json at all' }));

    const { default: aiService } = await import('../../services/aiService.js');
    await expect(aiService.generateQuiz('2 + 2 equals 4.')).rejects.toMatchObject({ code: 'bad_output' });
  });

  it('reads the REAL reason out of the cause chain, not just "fetch failed"', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');

    // This is exactly the shape Node's fetch throws: a bare TypeError whose
    // cause carries the code that says which layer actually broke. Reading
    // only .message - which is what the code used to do - turns every one of
    // these into the same unactionable "could not reach Google".
    const fetchFailure = (code, extra = {}) => {
      const cause = Object.assign(new Error(`${code} ${'generativelanguage.googleapis.com'}`), { code, ...extra });
      return Object.assign(new TypeError('fetch failed'), { cause });
    };

    const cases = [
      [fetchFailure('ENOTFOUND', { syscall: 'getaddrinfo', hostname: 'generativelanguage.googleapis.com' }), 'dns'],
      [fetchFailure('ECONNREFUSED', { syscall: 'connect', port: 443 }), 'blocked'],
      [fetchFailure('UND_ERR_CONNECT_TIMEOUT'), 'timeout'],
      [fetchFailure('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), 'tls'],
      [fetchFailure('SELF_SIGNED_CERT_IN_CHAIN'), 'tls'],
    ];

    for (const [thrown, expectedCode] of cases) {
      vi.resetModules();
      mockSdk(vi.fn().mockRejectedValue(thrown));
      const { default: aiService } = await import('../../services/aiService.js');
      const error = await aiService.summarizeText('notes').catch((e) => e);
      expect(error.code, `for ${thrown.cause.code}`).toBe(expectedCode);
      // The detail must carry the underlying code so it can be shown.
      expect(error.detail).toContain(thrown.cause.code);
      vi.doUnmock('@google/genai');
    }
  });

  it('never blames the API key for a failure that never reached Google', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    const cause = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    mockSdk(vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause })));

    const { default: aiService } = await import('../../services/aiService.js');
    const error = await aiService.summarizeText('notes').catch((e) => e);

    expect(error.code).toBe('timeout');
    expect(error.message).not.toMatch(/api key|rejected|quota/i);
  });

  it('tells a rejected key, an exhausted quota and a dead network apart', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');

    const cases = [
      ['API key not valid. Please pass a valid API key.', 'bad_key'],
      ['429 RESOURCE_EXHAUSTED: quota exceeded', 'quota'],
      ['fetch failed', 'network'],
    ];

    for (const [message, expectedCode] of cases) {
      vi.resetModules();
      mockSdk(vi.fn().mockRejectedValue(new Error(message)));
      const { default: aiService } = await import('../../services/aiService.js');
      await expect(aiService.summarizeText('notes')).rejects.toMatchObject({ code: expectedCode });
      vi.doUnmock('@google/genai');
    }
  });

  it('falls back to a live model when the configured one has been retired', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.stubEnv('GEMINI_MODEL', 'gemini-retired');

    // Google answers 404 for a retired model ID. Rather than guess a
    // replacement name (which goes stale on the next retirement), the service
    // asks the key which models it can actually call.
    const generateContent = vi.fn()
      .mockRejectedValueOnce(new Error('404 NOT_FOUND: models/gemini-retired is no longer available'))
      .mockResolvedValueOnce({ text: 'summary text' });

    const list = vi.fn().mockResolvedValue([
      { name: 'models/text-embedding-004', supportedActions: ['embedContent'] },
      { name: 'models/gemini-3.1-flash', supportedActions: ['generateContent'] },
      { name: 'models/gemini-3.7-flash', supportedActions: ['generateContent'] },
      { name: 'models/gemini-3.7-flash-image', supportedActions: ['generateContent'] },
    ]);
    mockSdk(generateContent, list);

    const { default: aiService, activeModelName } = await import('../../services/aiService.js');
    await expect(aiService.summarizeText('notes')).resolves.toBe('summary text');

    expect(generateContent).toHaveBeenCalledTimes(2);
    // Newest flash-class TEXT model - not the older 3.1, not the image variant.
    expect(generateContent.mock.calls[1][0].model).toBe('gemini-3.7-flash');
    expect(activeModelName()).toBe('gemini-3.7-flash');
  });

  it('sends chat history as a plain contents array with alternating roles', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    const generateContent = vi.fn().mockResolvedValue({ text: 'Hi there!' });
    mockSdk(generateContent);

    const { default: aiService } = await import('../../services/aiService.js');
    const reply = await aiService.generateChatResponse(
      [{ role: 'user', message: 'hello' }, { role: 'model', message: 'hi!' }],
      'how are you?'
    );

    expect(reply).toBe('Hi there!');
    const callArgs = generateContent.mock.calls[0][0];
    expect(callArgs.contents).toEqual([
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'hi!' }] },
      { role: 'user', parts: [{ text: 'how are you?' }] },
    ]);
  });

  it('defaults to gemini-3.7-flash and sends no 3.x-forbidden parameters', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.stubEnv('GEMINI_MODEL', '');
    const generateContent = vi.fn().mockResolvedValue({ text: 'ok' });
    mockSdk(generateContent);

    const { default: aiService } = await import('../../services/aiService.js');
    await aiService.summarizeText('notes');

    const call = generateContent.mock.calls[0][0];
    expect(call.model).toBe('gemini-3.7-flash');
    // Gemini 3.x rejects these; the app must never start sending them.
    // (thinkingLevel IS sent, and is a 3.x parameter - see the test below.)
    const config = call.config || {};
    expect(config).not.toHaveProperty('temperature');
    expect(config).not.toHaveProperty('topP');
    expect(config).not.toHaveProperty('topK');
    expect(config).not.toHaveProperty('candidateCount');
  });

  it('sends thinkingLevel only when asked, and only to a 3.x model', async () => {
    // Opted in, on a 3.x model -> sent.
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.stubEnv('GEMINI_THINKING_LEVEL', 'low');
    let generateContent = vi.fn().mockResolvedValue({ text: 'ok' });
    mockSdk(generateContent);
    let { default: aiService } = await import('../../services/aiService.js');
    await aiService.summarizeText('notes');
    expect(generateContent.mock.calls[0][0].config).toEqual({ thinkingLevel: 'low' });

    // Opted in, but pinned to a 2.x model -> NOT sent; thinkingLevel is a
    // 3.x-only parameter and 2.x answers 400 for it.
    vi.resetModules();
    vi.doUnmock('@google/genai');
    vi.stubEnv('GEMINI_MODEL', 'gemini-2.5-flash');
    generateContent = vi.fn().mockResolvedValue({ text: 'ok' });
    mockSdk(generateContent);
    ({ default: aiService } = await import('../../services/aiService.js'));
    await aiService.summarizeText('notes');
    expect(generateContent.mock.calls[0][0].config).toBeUndefined();

    // Nothing set -> 'low' is this app's default, because Google's 'medium'
    // was slow enough to produce 504 DEADLINE_EXCEEDED on a plain question.
    vi.resetModules();
    vi.doUnmock('@google/genai');
    vi.stubEnv('GEMINI_MODEL', '');
    vi.stubEnv('GEMINI_THINKING_LEVEL', '');
    generateContent = vi.fn().mockResolvedValue({ text: 'ok' });
    mockSdk(generateContent);
    ({ default: aiService } = await import('../../services/aiService.js'));
    await aiService.summarizeText('notes');
    expect(generateContent.mock.calls[0][0].config).toEqual({ thinkingLevel: 'low' });
  });

  it('reports a Google 504 as a deadline, never as a connectivity problem', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');

    // Exactly what came back from the live API: Google answered, so the key,
    // the network and the model are all fine - the model simply did not
    // finish inside the deadline it was given.
    const deadline = Object.assign(
      new Error('{"error":{"code":504,"message":"Deadline expired before operation could complete.","status":"DEADLINE_EXCEEDED"}}'),
      { name: 'ApiError', status: 504 }
    );
    mockSdk(vi.fn().mockRejectedValue(deadline));

    const { default: aiService } = await import('../../services/aiService.js');
    const error = await aiService.summarizeText('notes').catch((e) => e);

    expect(error.code).toBe('deadline');
    expect(error.status).toBe(504);
    // Must NOT be mistaken for the machine being offline - that sends people
    // off checking a firewall that was never the problem.
    expect(error.message).not.toMatch(/internet connection|firewall|could not reach|DNS/i);
    expect(error.message).toMatch(/reached Google/i);
  });

  it('asks Google for a deadline long enough that Google is not the one giving up', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.stubEnv('GEMINI_TIMEOUT_MS', '');
    const GoogleGenAI = vi.fn(function GoogleGenAIMock() {
      this.models = { generateContent: vi.fn().mockResolvedValue({ text: 'ok' }), list: vi.fn() };
    });
    vi.doMock('@google/genai', () => ({ GoogleGenAI }));

    await import('../../services/aiService.js');

    // The SDK turns httpOptions.timeout into X-Server-Timeout (in whole
    // seconds), i.e. the deadline GOOGLE works to. A small value here is what
    // produced 504 DEADLINE_EXCEEDED, so this guards against it shrinking.
    const { httpOptions } = GoogleGenAI.mock.calls[0][0];
    expect(httpOptions.timeout).toBeGreaterThanOrEqual(120000);
    // And transient failures are retried rather than surfaced.
    expect(httpOptions.retryOptions.httpStatusCodes).toContain(504);
    expect(httpOptions.retryOptions.attempts).toBeGreaterThan(1);
  });

  it('names the status and Google\'s own wording instead of a bare "returned an error"', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');

    // What the SDK throws for a refused request: an ApiError with a status
    // and Google's JSON body as the message. The old classifier had no branch
    // for a plain 400, so this became the unactionable sentence
    // "The AI service returned an error."
    const apiError = Object.assign(
      new Error('{"error":{"code":400,"message":"Invalid JSON payload received. Unknown name \"foo\".","status":"INVALID_ARGUMENT"}}'),
      { name: 'ApiError', status: 400 }
    );
    mockSdk(vi.fn().mockRejectedValue(apiError));

    const { default: aiService } = await import('../../services/aiService.js');
    const error = await aiService.summarizeText('notes').catch((e) => e);

    expect(error.code).toBe('bad_request');
    expect(error.message).toContain('400');
    // Google's own sentence, lifted out of the JSON body.
    expect(error.message).toContain('Invalid JSON payload');
  });

  it('still says something useful for a completely unrecognised failure', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    mockSdk(vi.fn().mockRejectedValue(
      Object.assign(new Error('something nobody has seen before'), { status: 418 })
    ));

    const { default: aiService } = await import('../../services/aiService.js');
    const error = await aiService.summarizeText('notes').catch((e) => e);

    expect(error.code).toBe('ai_error');
    expect(error.message).toContain('418');
    expect(error.message).toContain('something nobody has seen before');
  });

  it('firstUsefulLine pulls the message out of a Google JSON error body', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'x');
    const { firstUsefulLine } = await import('../../services/aiService.js');

    expect(firstUsefulLine('{"error":{"code":429,"message":"Quota exceeded for requests."}}'))
      .toBe('Quota exceeded for requests.');
    expect(firstUsefulLine('plain text  <-  [ECONNREFUSED] connect')).toBe('plain text');
    expect(firstUsefulLine('')).toBe('');
  });

  it('selfTest reports success without throwing', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    mockSdk(vi.fn().mockResolvedValue({ text: 'OK' }));

    const { default: aiService } = await import('../../services/aiService.js');
    await expect(aiService.selfTest()).resolves.toMatchObject({ ok: true, reply: 'OK' });
  });
});

describe('free-tier quota is treated as a budget, not a transient error', () => {
  // The real body from the live API: 20 requests per DAY for
  // gemini-3.7-flash, with a suggested retry delay.
  const QUOTA_BODY = JSON.stringify({
    error: {
      code: 429,
      message: 'You exceeded your current quota. Please retry in 32.436646756s.',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [{
            quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
            quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
            quotaDimensions: { location: 'global', model: 'gemini-3.7-flash' },
            quotaValue: '20',
          }],
        },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '32s' },
      ],
    },
  });

  const quotaError = () =>
    Object.assign(new Error(QUOTA_BODY), { name: 'ApiError', status: 429 });

  it('never retries a 429 - each retry would spend another request', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    const GoogleGenAI = vi.fn(function GoogleGenAIMock() {
      this.models = { generateContent: vi.fn(), list: vi.fn() };
    });
    vi.doMock('@google/genai', () => ({ GoogleGenAI }));
    await import('../../services/aiService.js');

    const { httpOptions } = GoogleGenAI.mock.calls[0][0];
    expect(httpOptions.retryOptions.httpStatusCodes).not.toContain(429);
    // The transient ones are still retried.
    expect(httpOptions.retryOptions.httpStatusCodes).toContain(503);
  });

  it('reports which quota, how big it is and when to come back', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    mockSdk(vi.fn().mockRejectedValue(quotaError()));

    const { default: aiService } = await import('../../services/aiService.js');
    const error = await aiService.summarizeText('notes').catch((e) => e);

    expect(error.code).toBe('quota');
    expect(error.message).toContain('20 requests per day');
    expect(error.message).toContain('gemini-3.7-flash');
    expect(error.message).toMatch(/32 seconds/);
    expect(error.message).toContain('ai.dev/rate-limit');
  });

  it('stops calling Google once the allowance is gone', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    const generateContent = vi.fn().mockRejectedValue(quotaError());
    mockSdk(generateContent);

    const { default: aiService } = await import('../../services/aiService.js');

    await aiService.summarizeText('one').catch(() => {});
    await aiService.summarizeText('two').catch(() => {});
    await aiService.summarizeText('three').catch(() => {});

    // Only the FIRST call goes out. The rest fail locally - otherwise a
    // student clicking around spends the rest of the day's allowance
    // discovering the same thing over and over.
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('skips the background features entirely while out of quota', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    const generateContent = vi.fn().mockRejectedValue(quotaError());
    mockSdk(generateContent);

    const { default: aiService } = await import('../../services/aiService.js');
    await aiService.summarizeText('trip the breaker').catch(() => {});
    generateContent.mockClear();

    // Neither of these is something the student asked for.
    await expect(aiService.generateKeywords('a pdf')).resolves.toBe('');
    await expect(aiService.getRecommendations('maths')).resolves.toBe('[]');
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('caches dashboard recommendations instead of asking once per page load', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    const generateContent = vi.fn().mockResolvedValue({ text: '["algebra","vectors"]' });
    mockSdk(generateContent);

    const { default: aiService } = await import('../../services/aiService.js');

    // Five dashboard loads, same fixed interests string.
    for (let i = 0; i < 5; i += 1) await aiService.getRecommendations('computer science');

    // One request, not five. On a 20-per-day allowance this is the
    // difference between the dashboard costing the whole budget and costing
    // almost nothing.
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});


describe('Google overload (503) falls back to another model instead of giving up', () => {
  // The real body: "This model is currently experiencing high demand."
  const overloaded = () => Object.assign(
    new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}'),
    { name: 'ApiError', status: 503 }
  );

  const modelList = () => vi.fn().mockResolvedValue([
    { name: 'models/gemini-3.7-flash', supportedActions: ['generateContent'] },
    { name: 'models/gemini-3.1-flash-lite', supportedActions: ['generateContent'] },
    { name: 'models/text-embedding-004', supportedActions: ['embedContent'] },
  ]);

  it('answers from an alternate model when the primary is overloaded', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    const generateContent = vi.fn()
      .mockRejectedValueOnce(overloaded())          // gemini-3.7-flash is busy
      .mockResolvedValueOnce({ text: 'the answer' }); // the alternate is not
    mockSdk(generateContent, modelList());

    const { default: aiService } = await import('../../services/aiService.js');

    // The student gets an answer; the 503 never reaches them.
    await expect(aiService.summarizeText('notes')).resolves.toBe('the answer');
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(generateContent.mock.calls[0][0].model).toBe('gemini-3.7-flash');
    expect(generateContent.mock.calls[1][0].model).not.toBe('gemini-3.7-flash');
  });

  it('remembers the busy model, so the next question skips it', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    const generateContent = vi.fn()
      .mockRejectedValueOnce(overloaded())
      .mockResolvedValue({ text: 'ok' });
    mockSdk(generateContent, modelList());

    const { default: aiService } = await import('../../services/aiService.js');
    await aiService.summarizeText('first');
    generateContent.mockClear();

    await aiService.summarizeText('second');

    // Straight to the model that worked - no second trip through the
    // congested one, which would waste a request from the daily allowance.
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(generateContent.mock.calls[0][0].model).not.toBe('gemini-3.7-flash');
  });

  it('says so plainly when every model it tried is busy', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    mockSdk(vi.fn().mockRejectedValue(overloaded()), modelList());

    const { default: aiService } = await import('../../services/aiService.js');
    const error = await aiService.summarizeText('notes').catch((e) => e);

    expect(error.code).toBe('upstream');
    expect(error.message).toMatch(/busy|high demand/i);
    // Not the app's fault and not the key's - say so.
    expect(error.message).toMatch(/capacity on Google/i);
  });

  it('does NOT burn extra requests trying other models for a key or quota problem', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    const generateContent = vi.fn().mockRejectedValue(
      Object.assign(new Error('API key not valid. Please pass a valid API key.'), { status: 400 })
    );
    mockSdk(generateContent, modelList());

    const { default: aiService } = await import('../../services/aiService.js');
    await aiService.summarizeText('notes').catch(() => {});

    // A different model would be rejected in exactly the same way.
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('never tries more models than GEMINI_MODEL_ATTEMPTS allows', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.stubEnv('GEMINI_MODEL_ATTEMPTS', '2');
    const generateContent = vi.fn().mockRejectedValue(overloaded());
    mockSdk(generateContent, modelList());

    const { default: aiService } = await import('../../services/aiService.js');
    await aiService.summarizeText('notes').catch(() => {});

    // Bounded on purpose: each attempt costs one of 20 requests a day.
    expect(generateContent).toHaveBeenCalledTimes(2);
  });
});


describe('quota is per MODEL, so one exhausted model is not "the AI is out of quota"', () => {
  // Google's quota id is GenerateRequestsPerDayPerProjectPerModel-FreeTier -
  // "PerModel". Spending gemini-3.7-flash's 20 daily requests says nothing
  // about another model, which has its own separate allowance. Treating one
  // model's limit as a global outage is what made five attempts in a row all
  // return the same cached message without contacting Google at all.
  const quotaBody = (model) => JSON.stringify({
    error: {
      code: 429,
      message: 'You exceeded your current quota. Please retry in 44.1s.',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [{
            quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
            quotaDimensions: { location: 'global', model },
            quotaValue: '20',
          }],
        },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '44s' },
      ],
    },
  });

  const exhausted = (model) =>
    Object.assign(new Error(quotaBody(model)), { name: 'ApiError', status: 429 });

  const modelList = () => vi.fn().mockResolvedValue([
    { name: 'models/gemini-3.7-flash', supportedActions: ['generateContent'] },
    { name: 'models/gemini-3.1-flash-lite', supportedActions: ['generateContent'] },
  ]);

  it('answers from another model when the primary has spent its daily allowance', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    const generateContent = vi.fn()
      .mockRejectedValueOnce(exhausted('gemini-3.7-flash'))
      .mockResolvedValueOnce({ text: 'the answer' });
    mockSdk(generateContent, modelList());

    const { default: aiService } = await import('../../services/aiService.js');

    await expect(aiService.summarizeText('notes')).resolves.toBe('the answer');
    expect(generateContent.mock.calls[1][0].model).toBe('gemini-3.1-flash-lite');
  });

  it('stops using the exhausted model without spending more requests on it', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    const generateContent = vi.fn()
      .mockRejectedValueOnce(exhausted('gemini-3.7-flash'))
      .mockResolvedValue({ text: 'ok' });
    mockSdk(generateContent, modelList());

    const { default: aiService, quotaBlockedModels } = await import('../../services/aiService.js');
    await aiService.summarizeText('first');
    expect(quotaBlockedModels()).toContain('gemini-3.7-flash');

    generateContent.mockClear();
    await aiService.summarizeText('second');

    // Straight to the model that still has allowance - the exhausted one is
    // skipped for free rather than costing a request to rediscover.
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(generateContent.mock.calls[0][0].model).toBe('gemini-3.1-flash-lite');
  });

  it('quotes the REAL remaining wait, not a sentence captured minutes ago', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    mockSdk(vi.fn().mockRejectedValue(exhausted('gemini-3.7-flash')), modelList());

    const { default: aiService } = await import('../../services/aiService.js');

    // Exhaust both models.
    const first = await aiService.summarizeText('a').catch((e) => e);
    expect(first.code).toBe('quota');

    // The next call is refused locally. Its countdown must be computed now,
    // and it must not contradict itself by promising 44 seconds forever.
    vi.setSystemTime(Date.now() + 20000);
    const later = await aiService.summarizeText('b').catch((e) => e);

    expect(later.code).toBe('quota');
    expect(later.message).toMatch(/Trying again in/);
    expect(later.detail).toContain('all models out of quota');
    vi.useRealTimers();
  });

  it('backs off further only when a model keeps coming back exhausted', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    // No alternates: list() rejects, so the primary is the only candidate.
    mockSdk(vi.fn().mockRejectedValue(exhausted('gemini-3.7-flash')),
            vi.fn().mockRejectedValue(new Error('no list')));

    const { default: aiService, quotaBlockedModels } = await import('../../services/aiService.js');

    await aiService.summarizeText('a').catch(() => {});
    expect(quotaBlockedModels()).toEqual(['gemini-3.7-flash']);

    // First hold honours Google's own suggestion (44s), so a per-minute limit
    // recovers quickly instead of the app sulking for ten minutes.
    vi.setSystemTime(Date.now() + 45000);
    expect(quotaBlockedModels()).toEqual([]);
    vi.useRealTimers();
  });
});
