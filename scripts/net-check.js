// Test, one layer at a time, whether this machine can reach the Gemini API.
//
//   npm run ai:net
//
// "Could not reach Google" is not actionable on its own: DNS, a blocked port,
// a proxy that swallows the connection and antivirus rewriting HTTPS
// certificates all produce the same bare "fetch failed" from Node. This walks
// the four steps in order and stops at the first one that fails, so the
// answer is "DNS is fine, the TCP connection is fine, the certificate is not"
// rather than a shrug.
//
// Uses only Node built-ins - it must work even when nothing else does.
import 'dotenv/config';
import dns from 'dns/promises';
import net from 'net';
import tls from 'tls';
import https from 'https';

const HOST = 'generativelanguage.googleapis.com';
const PORT = 443;
const TIMEOUT = 10000;

const ok = (m) => console.log(`  [ OK ]  ${m}`);
const bad = (m) => console.log(`  [FAIL]  ${m}`);
const info = (m) => console.log(`          ${m}`);
const line = () => console.log('='.repeat(62));

console.log('');
line();
console.log(` Can this machine reach ${HOST}?`);
line();

// ------------------------------------------------------------- environment
console.log('\n0. Environment');
info(`Node ${process.version} on ${process.platform}`);
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy ||
              process.env.HTTP_PROXY || process.env.http_proxy;
if (proxy) {
  info(`proxy variable set: ${proxy}`);
  let hasUndici = false;
  try { await import('undici'); hasUndici = true; } catch { /* not installed */ }
  if (hasUndici) ok('undici is installed, so the app can use that proxy');
  else bad('undici is NOT installed - Node\'s fetch will IGNORE that proxy. Run: npm install undici');
} else {
  info('no HTTP(S)_PROXY variable set (fine unless your network requires a proxy)');
  info('If your browser needs a proxy but this does not have one, that is the problem.');
}
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  info('NOTE: NODE_TLS_REJECT_UNAUTHORIZED=0 is set - TLS verification is OFF.');
}

let failed = false;
let addresses = [];

// -------------------------------------------------------------------- DNS
console.log('\n1. DNS - can the name be resolved?');
try {
  addresses = await dns.lookup(HOST, { all: true });
  ok(`${HOST} -> ${addresses.map((a) => a.address).join(', ')}`);
} catch (error) {
  failed = true;
  bad(`cannot resolve ${HOST}: ${error.code || error.message}`);
  info('');
  info('The name could not be looked up at all. Causes, most common first:');
  info('  - no internet connection right now');
  info('  - a VPN or DNS filter is blocking Google domains');
  info('  - a "hosts" file entry or DNS server that blackholes it');
}

// ------------------------------------------------------------- TCP connect
if (!failed) {
  console.log('\n2. TCP - can port 443 be opened?');
  const tcp = await new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port: PORT });
    socket.setTimeout(TIMEOUT);
    socket.once('connect', () => { socket.destroy(); resolve({ ok: true }); });
    socket.once('timeout', () => { socket.destroy(); resolve({ ok: false, code: 'ETIMEDOUT' }); });
    socket.once('error', (error) => { socket.destroy(); resolve({ ok: false, code: error.code || error.message }); });
  });

  if (tcp.ok) {
    ok(`connected to ${HOST}:${PORT}`);
  } else {
    failed = true;
    bad(`cannot open ${HOST}:${PORT} (${tcp.code})`);
    info('');
    info('DNS works but the connection does not. Causes, most common first:');
    info('  - Windows Defender Firewall is blocking node.exe (allow it, or');
    info('    add an outbound rule for port 443)');
    info('  - a university/company firewall requires a proxy: set HTTPS_PROXY');
    info('    and run "npm install undici", then restart the server');
    info('  - a VPN is routing traffic somewhere that drops it');
  }
}

// -------------------------------------------------------------------- TLS
if (!failed) {
  console.log('\n3. TLS - is the HTTPS certificate trusted?');
  const handshake = await new Promise((resolve) => {
    const socket = tls.connect({ host: HOST, port: PORT, servername: HOST, timeout: TIMEOUT }, () => {
      const cert = socket.getPeerCertificate();
      const issuer = (cert && cert.issuer && (cert.issuer.O || cert.issuer.CN)) || 'unknown';
      const authorized = socket.authorized;
      const reason = socket.authorizationError;
      socket.destroy();
      resolve({ ok: authorized, issuer, reason });
    });
    socket.once('timeout', () => { socket.destroy(); resolve({ ok: false, reason: 'ETIMEDOUT' }); });
    socket.once('error', (error) => { socket.destroy(); resolve({ ok: false, reason: error.code || error.message }); });
  });

  if (handshake.ok) {
    ok(`certificate verified (issued by ${handshake.issuer})`);
    // A certificate issued by anything other than a public CA means something
    // on this machine or network is decrypting and re-signing HTTPS.
    if (!/google|gts|globalsign|digicert|lets encrypt|amazon/i.test(handshake.issuer)) {
      info('');
      info(`NOTE: that issuer ("${handshake.issuer}") is not a public certificate`);
      info('authority. Something - antivirus, or a company proxy - is inspecting');
      info('HTTPS traffic. It is trusted here, so it works, but it is worth knowing.');
    }
  } else {
    failed = true;
    bad(`the certificate was not accepted: ${handshake.reason}`);
    info(`          issuer seen: ${handshake.issuer || 'unknown'}`);
    info('');
    info('The connection opened but HTTPS could not be established. Cause:');
    info('  - antivirus (Kaspersky, ESET, Avast, BitDefender) or a company');
    info('    proxy is intercepting HTTPS and presenting its own certificate,');
    info('    which Node does not trust the way your browser does.');
    info('  Fixes, best first:');
    info('    1. Turn off "HTTPS scanning" / "SSL scanning" in the antivirus');
    info('    2. Export its root certificate and point Node at it:');
    info('       set NODE_EXTRA_CA_CERTS=C:\\path\\to\\root.crt');
    info('    (Do NOT use NODE_TLS_REJECT_UNAUTHORIZED=0 - that disables');
    info('     certificate checking for every connection the app makes.)');
  }
}

// ------------------------------------------------------------------- HTTPS
if (!failed) {
  console.log('\n4. HTTPS - does Google answer?');
  const response = await new Promise((resolve) => {
    const req = https.request(
      { host: HOST, port: PORT, path: '/v1beta/models', method: 'GET', timeout: TIMEOUT },
      (res) => { res.resume(); resolve({ ok: true, status: res.statusCode }); }
    );
    req.once('timeout', () => { req.destroy(); resolve({ ok: false, code: 'ETIMEDOUT' }); });
    req.once('error', (error) => resolve({ ok: false, code: error.code || error.message }));
    req.end();
  });

  if (response.ok) {
    // 401/403 without a key is the CORRECT answer here: it proves the request
    // reached Google's API and came back.
    ok(`Google answered HTTP ${response.status} (a 401/403 without a key is expected and means the path is clear)`);
  } else {
    failed = true;
    bad(`no HTTP response: ${response.code}`);
  }
}

console.log('');
line();
if (failed) {
  console.log(' RESULT: this machine cannot reach the Gemini API.');
  console.log(' Fix the failing step above; the API key is not the problem.');
} else {
  console.log(' RESULT: the network path is clear.');
  console.log('');
  console.log(' So a "could not reach Google" error from the app is NOT the');
  console.log(' network. Run "npm run ai:check" - it makes a real API call and');
  console.log(' reports what Google says about the key and the model.');
}
line();
console.log('');
process.exit(failed ? 1 : 0);
