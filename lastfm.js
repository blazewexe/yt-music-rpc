'use strict';

// ─── Last.fm API Helper ────────────────────────────────────────────────────
// Implements the official Last.fm scrobbling protocol:
//   1. updateNowPlaying → sent immediately when a track starts
//   2. scrobble         → sent when min(50% of track duration, 4 minutes) elapses
//   Tracks shorter than 30s are never scrobbled.
//
// Auth uses auth.getMobileSession (user token flow) which MD5-hashes the
// password before transmission. The session key is the only thing persisted.
// ──────────────────────────────────────────────────────────────────────────

const LASTFM_API_ROOT = 'https://ws.audioscrobbler.com/2.0/';

// API credentials are stored in browser.storage.local — never bundled in the
// extension package. Users enter their own key/secret via the extension popup.
// Register a free API app at: https://www.last.fm/api/account/create

// ─── MD5 implementation (RFC 1321, no external deps) ──────────────────────
function md5(inputStr) {
  function safeAdd(x, y) {
    const lsw = (x & 0xffff) + (y & 0xffff);
    const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xffff);
  }
  function bitRotateLeft(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
  function md5cmn(q, a, b, x, s, t) { return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
  function md5ff(a, b, c, d, x, s, t) { return md5cmn((b & c) | (~b & d), a, b, x, s, t); }
  function md5gg(a, b, c, d, x, s, t) { return md5cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function md5hh(a, b, c, d, x, s, t) { return md5cmn(b ^ c ^ d, a, b, x, s, t); }
  function md5ii(a, b, c, d, x, s, t) { return md5cmn(c ^ (b | ~d), a, b, x, s, t); }

  function md5blk(s) {
    const md5blks = [];
    for (let i = 0; i < 64; i += 4) {
      md5blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
    }
    return md5blks;
  }

  function md5blk_array(a) {
    const md5blks = [];
    for (let i = 0; i < 64; i += 4) {
      md5blks[i >> 2] = a[i] + (a[i + 1] << 8) + (a[i + 2] << 16) + (a[i + 3] << 24);
    }
    return md5blks;
  }

  function md51(s) {
    const n = s.length;
    const state = [1732584193, -271733879, -1732584194, 271733878];
    let i;
    for (i = 64; i <= n; i += 64) {
      md5cycle(state, md5blk(s.substring(i - 64, i)));
    }
    s = s.substring(i - 64);
    const tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (i = 0; i < s.length; i++) {
      tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
    }
    tail[i >> 2] |= 0x80 << ((i % 4) << 3);
    if (i > 55) {
      md5cycle(state, tail);
      for (i = 0; i < 16; i++) tail[i] = 0;
    }
    tail[14] = n * 8;
    md5cycle(state, tail);
    return state;
  }

  function md5cycle(x, k) {
    let [a, b, c, d] = x;
    a = md5ff(a, b, c, d, k[0], 7, -680876936); d = md5ff(d, a, b, c, k[1], 12, -389564586);
    c = md5ff(c, d, a, b, k[2], 17, 606105819); b = md5ff(b, c, d, a, k[3], 22, -1044525330);
    a = md5ff(a, b, c, d, k[4], 7, -176418897); d = md5ff(d, a, b, c, k[5], 12, 1200080426);
    c = md5ff(c, d, a, b, k[6], 17, -1473231341); b = md5ff(b, c, d, a, k[7], 22, -45705983);
    a = md5ff(a, b, c, d, k[8], 7, 1770035416); d = md5ff(d, a, b, c, k[9], 12, -1958414417);
    c = md5ff(c, d, a, b, k[10], 17, -42063); b = md5ff(b, c, d, a, k[11], 22, -1990404162);
    a = md5ff(a, b, c, d, k[12], 7, 1804603682); d = md5ff(d, a, b, c, k[13], 12, -40341101);
    c = md5ff(c, d, a, b, k[14], 17, -1502002290); b = md5ff(b, c, d, a, k[15], 22, 1236535329);
    a = md5gg(a, b, c, d, k[1], 5, -165796510); d = md5gg(d, a, b, c, k[6], 9, -1069501632);
    c = md5gg(c, d, a, b, k[11], 14, 643717713); b = md5gg(b, c, d, a, k[0], 20, -373897302);
    a = md5gg(a, b, c, d, k[5], 5, -701558691); d = md5gg(d, a, b, c, k[10], 9, 38016083);
    c = md5gg(c, d, a, b, k[15], 14, -660478335); b = md5gg(b, c, d, a, k[4], 20, -405537848);
    a = md5gg(a, b, c, d, k[9], 5, 568446438); d = md5gg(d, a, b, c, k[14], 9, -1019803690);
    c = md5gg(c, d, a, b, k[3], 14, -187363961); b = md5gg(b, c, d, a, k[8], 20, 1163531501);
    a = md5gg(a, b, c, d, k[13], 5, -1444681467); d = md5gg(d, a, b, c, k[2], 9, -51403784);
    c = md5gg(c, d, a, b, k[7], 14, 1735328473); b = md5gg(b, c, d, a, k[12], 20, -1926607734);
    a = md5hh(a, b, c, d, k[5], 4, -378558); d = md5hh(d, a, b, c, k[8], 11, -2022574463);
    c = md5hh(c, d, a, b, k[11], 16, 1839030562); b = md5hh(b, c, d, a, k[14], 23, -35309556);
    a = md5hh(a, b, c, d, k[1], 4, -1530992060); d = md5hh(d, a, b, c, k[4], 11, 1272893353);
    c = md5hh(c, d, a, b, k[7], 16, -155497632); b = md5hh(b, c, d, a, k[10], 23, -1094730640);
    a = md5hh(a, b, c, d, k[13], 4, 681279174); d = md5hh(d, a, b, c, k[0], 11, -358537222);
    c = md5hh(c, d, a, b, k[3], 16, -722521979); b = md5hh(b, c, d, a, k[6], 23, 76029189);
    a = md5hh(a, b, c, d, k[9], 4, -640364487); d = md5hh(d, a, b, c, k[12], 11, -421815835);
    c = md5hh(c, d, a, b, k[15], 16, 530742520); b = md5hh(b, c, d, a, k[2], 23, -995338651);
    a = md5ii(a, b, c, d, k[0], 6, -198630844); d = md5ii(d, a, b, c, k[7], 10, 1126891415);
    c = md5ii(c, d, a, b, k[14], 15, -1416354905); b = md5ii(b, c, d, a, k[5], 21, -57434055);
    a = md5ii(a, b, c, d, k[12], 6, 1700485571); d = md5ii(d, a, b, c, k[3], 10, -1894986606);
    c = md5ii(c, d, a, b, k[10], 15, -1051523); b = md5ii(b, c, d, a, k[1], 21, -2054922799);
    a = md5ii(a, b, c, d, k[8], 6, 1873313359); d = md5ii(d, a, b, c, k[15], 10, -30611744);
    c = md5ii(c, d, a, b, k[6], 15, -1560198380); b = md5ii(b, c, d, a, k[13], 21, 1309151649);
    a = md5ii(a, b, c, d, k[4], 6, -145523070); d = md5ii(d, a, b, c, k[11], 10, -1120210379);
    c = md5ii(c, d, a, b, k[2], 15, 718787259); b = md5ii(b, c, d, a, k[9], 21, -343485551);
    x[0] = safeAdd(a, x[0]); x[1] = safeAdd(b, x[1]);
    x[2] = safeAdd(c, x[2]); x[3] = safeAdd(d, x[3]);
  }

  function rhex(n) {
    let s = '', j;
    for (j = 0; j < 4; j++) {
      s += ('0' + ((n >> (j * 8 + 4)) & 0x0f).toString(16)).slice(-1)
        + ('0' + ((n >> (j * 8)) & 0x0f).toString(16)).slice(-1);
    }
    return s;
  }

  // Encode input as UTF-8 then hash
  function toUtf8(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) {
        out += String.fromCharCode(c);
      } else if (c < 0x800) {
        out += String.fromCharCode(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else {
        out += String.fromCharCode(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return out;
  }

  return md51(toUtf8(inputStr)).map(rhex).join('');
}

// ─── API Signature ─────────────────────────────────────────────────────────
// Last.fm API signature: sorted params (excluding format/callback) joined as
// key+value pairs, then append the shared secret, then MD5 the whole string.
function apiSign(params, apiSecret) {
  const sorted = Object.keys(params).filter(k => k !== 'format').sort();
  const sigStr = sorted.map(k => k + params[k]).join('') + apiSecret;
  return md5(sigStr);
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────
async function lfmPost(params, apiKey, apiSecret) {
  if (!apiKey || !apiSecret) throw new Error('Last.fm API keys not configured. Open the extension popup and enter your API key and secret.');
  params.api_key = apiKey;
  params.format = 'json';
  params.api_sig = apiSign(params, apiSecret);

  const body = new URLSearchParams(params).toString();
  const res = await fetch(LASTFM_API_ROOT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Last.fm HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`Last.fm error ${json.error}: ${json.message}`);
  return json;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Authenticate and return a persistent session key.
 * Password is MD5-hashed before sending (Last.fm mobile auth spec).
 */
async function getMobileSession(username, password, apiKey, apiSecret) {
  const data = await lfmPost({
    method: 'auth.getMobileSession',
    username,
    authToken: md5(username.toLowerCase() + md5(password)),
  }, apiKey, apiSecret);
  return data.session.key; // persist this, not the password
}

/**
 * Tell Last.fm what's currently playing (no scrobble, just "now playing" widget).
 */
async function updateNowPlaying(sessionKey, song, apiKey, apiSecret) {
  if (!sessionKey || !song || !song.title) return;
  const params = {
    method: 'track.updateNowPlaying',
    sk: sessionKey,
    track: song.title,
    artist: song.artist || '',
    album: song.album || '',
  };
  if (song.duration) params.duration = String(Math.floor(song.duration));
  try {
    await lfmPost(params, apiKey, apiSecret);
    console.log('[lastfm] Now playing:', song.title);
  } catch (e) {
    console.error('[lastfm] updateNowPlaying failed:', e.message);
  }
}

/**
 * Scrobble a track. timestamp is Unix seconds (when track *started* playing).
 */
async function scrobble(sessionKey, song, timestamp, apiKey, apiSecret) {
  if (!sessionKey || !song || !song.title) return;
  const params = {
    method: 'track.scrobble',
    sk: sessionKey,
    'track[0]': song.title,
    'artist[0]': song.artist || '',
    'album[0]': song.album || '',
    'timestamp[0]': String(Math.floor(timestamp)),
  };
  if (song.duration) params['duration[0]'] = String(Math.floor(song.duration));
  try {
    const res = await lfmPost(params, apiKey, apiSecret);
    const accepted = res?.scrobbles?.['@attr']?.accepted;
    console.log(`[lastfm] Scrobbled: "${song.title}" (accepted=${accepted})`);
    return { ok: true, accepted };
  } catch (e) {
    console.error('[lastfm] scrobble failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// getMobileSession, updateNowPlaying, and scrobble are globals — background.js
// uses them directly since all background scripts share the same scope.
// Each function now accepts (apiKey, apiSecret) as the last two arguments;
// background.js reads these from browser.storage.local and passes them in.
