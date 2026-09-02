/**
 * npm run google:check
 *
 * Says exactly why the "Sign in with Google" button is or is not showing, and
 * prints the two values that have to match Google's console character for
 * character. Those two are where almost every failed setup actually goes
 * wrong, and Google's own error ("redirect_uri_mismatch") does not tell you
 * what it compared against.
 */
import dotenv from 'dotenv';
dotenv.config();

const clientID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
const callbackURL = process.env.GOOGLE_CALLBACK_URL
    || `http://localhost:${process.env.PORT || 3002}/auth/google/callback`;

const tick = (ok) => (ok ? '  OK  ' : ' MISS ');
const problems = [];

console.log('\nGoogle sign-in configuration');
console.log('============================\n');

console.log(`[${tick(Boolean(clientID))}] GOOGLE_CLIENT_ID`);
if (!clientID) {
    problems.push('GOOGLE_CLIENT_ID is not set in .env - this is why the button is hidden.');
} else if (!clientID.endsWith('.apps.googleusercontent.com')) {
    console.log(`         value: ${clientID.slice(0, 24)}...`);
    problems.push('GOOGLE_CLIENT_ID does not end in ".apps.googleusercontent.com". That is the client ID, not the project name or the API key.');
} else {
    console.log(`         ${clientID}`);
}

console.log(`[${tick(Boolean(clientSecret))}] GOOGLE_CLIENT_SECRET`);
if (!clientSecret) {
    problems.push('GOOGLE_CLIENT_SECRET is not set in .env.');
} else if (clientSecret.length < 20) {
    problems.push('GOOGLE_CLIENT_SECRET looks too short to be a real secret.');
} else {
    console.log(`         set (${clientSecret.length} characters)`);
}

const explicit = Boolean(process.env.GOOGLE_CALLBACK_URL);
console.log(`[${tick(explicit)}] GOOGLE_CALLBACK_URL`);
console.log(`         ${callbackURL}${explicit ? '' : '   <- defaulted, fine for local only'}`);

if (explicit) {
    if (!/^https?:\/\//.test(callbackURL)) {
        problems.push('GOOGLE_CALLBACK_URL must be a full URL starting with http:// or https://');
    }
    if (!callbackURL.endsWith('/auth/google/callback')) {
        problems.push('GOOGLE_CALLBACK_URL must end with /auth/google/callback - that is the route this app serves.');
    }
    if (callbackURL.startsWith('http://') && !callbackURL.includes('localhost')) {
        problems.push('GOOGLE_CALLBACK_URL is http:// on a public host. Google requires https:// for anything that is not localhost.');
    }
    if (callbackURL.endsWith('/')) {
        problems.push('GOOGLE_CALLBACK_URL has a trailing slash. Google compares this string exactly - a trailing slash is a mismatch.');
    }
}

const enabled = Boolean(clientID && clientSecret);
console.log(`\nButton on the login page: ${enabled ? 'SHOWN' : 'HIDDEN'}`);
console.log('(the page asks /api/auth/providers and hides the button when this is off,');
console.log(' because a button that always fails is worse than no button)\n');

if (problems.length) {
    console.log('Problems');
    console.log('--------');
    problems.forEach((p) => console.log(`  - ${p}`));
}

if (!enabled) {
    console.log(`
How to switch it on
-------------------
1. https://console.cloud.google.com/  ->  create or pick a project
2. APIs & Services  ->  OAuth consent screen
     User type: External. Fill in the app name and your email.
     While it is in "Testing", add your own Google account under
     "Test users" - otherwise Google refuses your own sign-in.
3. APIs & Services  ->  Credentials  ->  Create credentials
     -> OAuth client ID -> Web application
     Authorized redirect URIs: add EXACTLY
         ${callbackURL}
     (and the https:// version of it for your deployed site)
4. Copy the client ID and secret into .env:
         GOOGLE_CLIENT_ID=...apps.googleusercontent.com
         GOOGLE_CLIENT_SECRET=...
         GOOGLE_CALLBACK_URL=${callbackURL}
5. Restart the server and reload /login. The button appears by itself.
`);
} else if (!problems.length) {
    console.log('Looks right. If Google still refuses:');
    console.log('  - "redirect_uri_mismatch": the URI above is not in the Credentials');
    console.log('    screen, character for character (http vs https, trailing slash, port).');
    console.log('  - "access_blocked" / "app not verified": add your account under');
    console.log('    "Test users" on the OAuth consent screen.\n');
}
