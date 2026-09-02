// Find out exactly why the Gemini features are or are not working.
//
//   npm run ai:check
//
// This makes ONE real request to Google with the key in your .env and prints
// what came back. It exists because the app used to answer every AI failure
// with the words "AI Error" and nothing else, so "I changed the key and it
// still does not work" was impossible to act on.
//
// Nothing is modified, and the key itself is never printed in full.
import 'dotenv/config';
import aiService, { describeApiKey, listAvailableModels, isAiConfigured, proxyStatus } from '../services/aiService.js';

const line = () => console.log('='.repeat(62));
const ok = (m) => console.log(`  [ OK ]  ${m}`);
const bad = (m) => console.log(`  [FAIL]  ${m}`);
const info = (m) => console.log(`          ${m}`);

console.log('');
line();
console.log(' Student Helper - Gemini AI check');
line();
console.log('');

// ---------------------------------------------------------------- 1. key
console.log('1. The API key in .env');
const key = describeApiKey();
const raw = (process.env.GEMINI_API_KEY || '').trim();

if (!isAiConfigured) {
  bad('GEMINI_API_KEY is not set.');
  info('Add it to .env, then restart the server:');
  info('  GEMINI_API_KEY=your-key-here');
  info('Get one from https://aistudio.google.com/apikey');
  process.exit(1);
}

info(`value    ${raw.slice(0, 6)}…${raw.slice(-4)}  (${raw.length} characters)`);
if (key.ok) ok(key.message);
else bad(key.message);

if (!key.ok && key.kind !== 'unknown') {
  info('');
  info('Fix that first - the rest of this check cannot succeed with it.');
  process.exit(1);
}
console.log('');

// -------------------------------------------------------------- 2. model
console.log('2. The model');
info(`GEMINI_MODEL = ${process.env.GEMINI_MODEL || '(not set - defaults to gemini-3.7-flash)'}`);
info(`GEMINI_THINKING_LEVEL = ${process.env.GEMINI_THINKING_LEVEL || 'low (this app\'s default)'}`);
info(`GEMINI_TIMEOUT_MS = ${process.env.GEMINI_TIMEOUT_MS || '120000 (default)'}  <- also sent to Google as its deadline`);
console.log('');

// ----------------------------------------------------------- 3. real call
console.log('3. Network');
info(`Node ${process.version} on ${process.platform}`);
if (proxyStatus === 'applied') ok('a proxy is configured and in use');
else if (proxyStatus === 'undici-missing') bad('a proxy is configured but unusable - run: npm install undici');
else if (proxyStatus === 'configured-not-applied') info('a proxy is configured (applying it at first use)');
else info('no proxy configured');
console.log('');

console.log('4. A real request to Google');
const result = await aiService.selfTest();

if (result.ok) {
  ok(`"${result.model}" answered: ${result.reply}`);
  console.log('');
  line();
  console.log(' RESULT: the AI is working.');
  console.log('');
  console.log(' If the app still shows no AI replies, the server is running');
  console.log(' with an older copy of .env - environment variables are read');
  console.log(' once at startup. Stop it and run "npm start" again.');
  line();
  console.log('');
  process.exit(0);
}

bad(result.error?.message || 'The request failed.');
if (result.error?.detail) {
  info('');
  // The FULL cause chain, not just the outer message. Node reports every
  // transport failure as "fetch failed"; the code that says which layer broke
  // (ENOTFOUND, ECONNREFUSED, UNABLE_TO_VERIFY_LEAF_SIGNATURE, ...) is nested
  // inside error.cause, and that is the part worth reading.
  info('Underlying error:');
  String(result.error.detail).split('  <-  ').forEach((l) => info(`  ${l}`));
}

// If the key works but the model does not, the useful answer is the list of
// models this key CAN call - so the fix is a one-line .env change.
// Listing the models matters for a quota failure too: picking one with a
// larger free allowance is the usual way out.
if (result.error?.code === 'model' || result.error?.code === 'quota') {
  console.log('');
  console.log('   Models this key can use:');
  try {
    const models = await listAvailableModels();
    if (models.length === 0) {
      info('   (none returned - the key may not have access to any model)');
    } else {
      models.slice(0, 20).forEach((m) => info(`   - ${m}`));
      if (models.length > 20) info(`   …and ${models.length - 20} more`);
      console.log('');
      info(`   Put one of them in .env:  GEMINI_MODEL=${models[0]}`);
    }
  } catch (error) {
    info(`   could not list models: ${error.message}`);
  }
}

console.log('');
line();
console.log(' RESULT: the AI is NOT working. What to check, in order:');
console.log('');
switch (result.error?.code) {
  case 'bad_key':
  case 'forbidden':
    console.log('  1. The key is real but Google will not accept it. Open');
    console.log('     https://aistudio.google.com/apikey and confirm the key');
    console.log('     still exists and is not restricted.');
    console.log('  2. If the key belongs to a Google Cloud project, that');
    console.log('     project needs the "Generative Language API" enabled.');
    console.log('  3. Copy the key again - a truncated paste looks valid.');
    break;
  case 'quota':
    console.log('  1. The free allowance for this key is used up for now.');
    console.log('  2. Wait for the daily reset, or enable billing on the');
    console.log('     key\'s Google Cloud project.');
    break;
  case 'model':
    console.log('  1. Set GEMINI_MODEL in .env to one of the models listed');
    console.log('     above, then restart the server.');
    break;
  case 'dns':
  case 'timeout':
  case 'blocked':
  case 'tls':
  case 'network':
    console.log('  The request never reached Google, so the API key is not');
    console.log('  the problem. Run this - it tests DNS, the connection and the');
    console.log('  certificate separately and names the step that fails:');
    console.log('');
    console.log('      npm run ai:net');
    console.log('');
    break;
  case 'deadline':
    console.log('  The request DID reach Google - the key and the network are');
    console.log('  fine. The model just did not finish inside the time it was');
    console.log('  allowed, and Google returned 504 DEADLINE_EXCEEDED.');
    console.log('');
    console.log('  1. Try again - it is usually transient, and the app now');
    console.log('     retries automatically.');
    console.log('  2. Keep GEMINI_THINKING_LEVEL=low (the default). "medium"');
    console.log('     and "high" make the model deliberate for much longer.');
    console.log('  3. Raise the deadline if your files are large:');
    console.log('       GEMINI_TIMEOUT_MS=180000');
    console.log('     NOTE: this value is sent to Google as its own deadline,');
    console.log('     so setting it LOW is what causes this error.');
    break;
  case 'upstream':
    console.log('  1. Google\'s own service is having trouble. Try again shortly.');
    break;
  default:
    console.log('  Read the message from Google above - it names the problem.');
}
line();
console.log('');
process.exit(1);
