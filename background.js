'use strict';

if (typeof browser === 'undefined') { var browser = chrome; }

// lastfm.js is loaded before this file via manifest.json background.scripts order

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

const OP = {
  DISPATCH:        0,
  HEARTBEAT:       1,
  IDENTIFY:        2,
  PRESENCE_UPDATE: 3,
  RESUME:          6,
  RECONNECT:       7,
  INVALID_SESSION: 9,
  HELLO:           10,
  HEARTBEAT_ACK:   11,
};

// ─── Core state ─────────────────────────────────────────────────────────────
let state = {
  // Discord
  token:       null,
  user:        null,
  rpcEnabled:  true,
  status:      'online',
  currentSong: null,
  connected:   false,
  sessionId:   null,
  assetCache:  new Map(),

  // Last.fm
  lastfmApiKey:     null,   // stored in browser.storage.local by the user
  lastfmApiSecret:  null,   // stored in browser.storage.local by the user
  lastfmSessionKey: null,
  lastfmUsername:   null,
  lastfmEnabled:    true,
  lastfmScrobbles:  0,          // count this session
  lastfmNowPlaying: null,       // "title::artist" key of the last nowPlaying sent
};

// ─── Scrobble timer ──────────────────────────────────────────────────────────
// Official Last.fm scrobbling rules:
//   • Track must be longer than 30 seconds
//   • Scrobble fires when the user has listened to ≥ 50% of the track
//     OR ≥ 4 minutes, whichever comes first
//   • The same track+start-time is never scrobbled twice
let scrobbleTimer    = null;
let scrobbleTrackKey = null; // "title::artist::startTimestamp" — dedup guard

function scheduleScrobble(song) {
  clearScrobbleTimer();
  if (!state.lastfmSessionKey || !state.lastfmEnabled) return;
  if (!song || !song.title) return;

  const duration = song.duration; // seconds
  if (!duration || duration < 30) return; // Last.fm: < 30 s not scrobbled

  const startTs  = song.startTimestamp ? Math.floor(song.startTimestamp / 1000) : Math.floor(Date.now() / 1000);
  const trackKey = `${song.title}::${song.artist || ''}::${startTs}`;
  if (scrobbleTrackKey === trackKey) return; // already scrobbled this play

  // Delay = min(duration / 2, 240) seconds, converted to ms
  const delayMs = Math.min((duration / 2) * 1000, 240_000);
  console.log(`[lastfm] Will scrobble "${song.title}" in ${Math.round(delayMs / 1000)}s`);

  scrobbleTimer = setTimeout(async () => {
    if (scrobbleTrackKey === trackKey) return; // race-condition guard
    scrobbleTrackKey = trackKey;

    const result = await scrobble(state.lastfmSessionKey, song, startTs, state.lastfmApiKey, state.lastfmApiSecret);
    if (result?.ok) {
      state.lastfmScrobbles++;
      broadcastState();
    }
  }, delayMs);
}

function clearScrobbleTimer() {
  clearTimeout(scrobbleTimer);
  scrobbleTimer = null;
}

// ─── Last.fm: updateNowPlaying ───────────────────────────────────────────────
async function lfmUpdateNowPlaying(song) {
  if (!state.lastfmSessionKey || !state.lastfmEnabled || !song) return;
  const key = `${song.title}::${song.artist || ''}`;
  if (state.lastfmNowPlaying === key) return; // avoid spamming the same track
  state.lastfmNowPlaying = key;
  await updateNowPlaying(state.lastfmSessionKey, song, state.lastfmApiKey, state.lastfmApiSecret);
}

// ─── Persistence ─────────────────────────────────────────────────────────────
let loginTabId    = null;
let tokenCaptured = false;

let ws               = null;
let heartbeatTimer   = null;
let reconnectTimer   = null;
let reconnectDelay   = 1000;
let seq              = null;
let lastHeartbeatAck = true;
let isResuming       = false;

async function loadState() {
  const stored = await browser.storage.local.get([
    'token', 'user', 'rpcEnabled', 'status',
    'lastfmApiKey', 'lastfmApiSecret',
    'lastfmSessionKey', 'lastfmUsername', 'lastfmEnabled', 'lastfmScrobbles',
  ]);
  if (stored.token            != null) state.token            = stored.token;
  if (stored.user             != null) state.user             = stored.user;
  if (stored.rpcEnabled       != null) state.rpcEnabled       = stored.rpcEnabled;
  if (stored.status           != null) state.status           = stored.status;
  if (stored.lastfmApiKey     != null) state.lastfmApiKey     = stored.lastfmApiKey;
  if (stored.lastfmApiSecret  != null) state.lastfmApiSecret  = stored.lastfmApiSecret;
  if (stored.lastfmSessionKey != null) state.lastfmSessionKey = stored.lastfmSessionKey;
  if (stored.lastfmUsername   != null) state.lastfmUsername   = stored.lastfmUsername;
  if (stored.lastfmEnabled    != null) state.lastfmEnabled    = stored.lastfmEnabled;
  if (stored.lastfmScrobbles  != null) state.lastfmScrobbles  = stored.lastfmScrobbles;
}

function persist() {
  browser.storage.local.set({
    token:            state.token,
    user:             state.user,
    rpcEnabled:       state.rpcEnabled,
    status:           state.status,
    lastfmApiKey:     state.lastfmApiKey,
    lastfmApiSecret:  state.lastfmApiSecret,
    lastfmSessionKey: state.lastfmSessionKey,
    lastfmUsername:   state.lastfmUsername,
    lastfmEnabled:    state.lastfmEnabled,
    lastfmScrobbles:  state.lastfmScrobbles,
  });
}

// ─── Discord token capture ───────────────────────────────────────────────────
let webRequestListener = null;
let webRequestTimeout  = null;

function startWebRequestCapture() {
  if (webRequestListener) return;
  tokenCaptured = false;

  console.log('[yt-music-rpc] webRequest capture started');

  webRequestListener = (details) => {
    if (tokenCaptured) return;
    const headers    = details.requestHeaders || [];
    const authHeader = headers.find(h => h.name.toLowerCase() === 'authorization');
    if (!authHeader || !authHeader.value) return;
    const val = authHeader.value.trim();
    if (val.length < 20 || val.startsWith('Bot ') || val.startsWith('Bearer ')) return;
    console.log('[yt-music-rpc] Got token via webRequest');
    handleDiscordToken(val);
  };

  const extraSpec = ['requestHeaders'];
  if (typeof chrome !== 'undefined' && chrome.webRequest && !navigator.userAgent.includes('Firefox')) {
    extraSpec.push('extraHeaders');
  }

  browser.webRequest.onBeforeSendHeaders.addListener(
    webRequestListener,
    { urls: ['https://discord.com/api/*', 'https://discordapp.com/api/*'] },
    extraSpec
  );

  webRequestTimeout = setTimeout(() => {
    if (!tokenCaptured) {
      stopWebRequestCapture();
      browser.storage.local.remove('pendingLogin');
      broadcastState({ loginError: 'Timed out reading Discord session. Make sure you are logged into discord.com and try again.' });
    }
  }, 90_000);
}

function stopWebRequestCapture() {
  if (webRequestListener) {
    browser.webRequest.onBeforeSendHeaders.removeListener(webRequestListener);
    webRequestListener = null;
  }
  clearTimeout(webRequestTimeout);
  webRequestTimeout = null;
}

function handleDiscordToken(token) {
  if (tokenCaptured) return;
  tokenCaptured = true;
  stopWebRequestCapture();
  browser.storage.local.remove('pendingLogin');
  state.token = token;
  persist();
  connect();
  if (loginTabId != null) {
    const tid = loginTabId;
    loginTabId = null;
    setTimeout(() => browser.tabs.remove(tid).catch(() => {}), 3000);
  }
  broadcastState();
}

// ─── Discord Gateway ─────────────────────────────────────────────────────────
function connect() {
  if (!state.token) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  console.log('[yt-music-rpc] Connecting to Discord Gateway…');
  try {
    ws = new WebSocket(GATEWAY_URL);
    ws.onopen = () => { console.log('[yt-music-rpc] Socket opened'); reconnectDelay = 1000; };
    ws.onmessage = (ev) => {
      try { handlePayload(JSON.parse(ev.data)); }
      catch (e) { console.error('[yt-music-rpc] Parse error:', e); }
    };
    ws.onclose = (ev) => {
      console.warn(`[yt-music-rpc] Gateway closed [${ev.code}]: ${ev.reason}`);
      state.connected = false;
      stopHeartbeat();
      broadcastState();
      if (ev.code === 4004) {
        console.error('[yt-music-rpc] Bad token (4004) — clearing.');
        state.token = null; state.user = null;
        persist(); broadcastState(); return;
      }
      scheduleReconnect();
    };
    ws.onerror = (err) => console.error('[yt-music-rpc] WS error:', err);
  } catch (err) {
    console.error('[yt-music-rpc] connect() threw:', err);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!state.token) return;
  reconnectTimer = setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    connect();
  }, reconnectDelay);
}

function disconnect(permanent = false) {
  clearTimeout(reconnectTimer);
  stopHeartbeat();
  if (permanent) { state.token = null; state.user = null; }
  if (ws) { const old = ws; ws = null; old.close(1000, 'User disconnected'); }
  state.connected = false;
}

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(payload)); return true; }
  return false;
}

function handlePayload({ op, d, s, t }) {
  if (s !== null && s !== undefined) seq = s;
  switch (op) {
    case OP.HELLO:
      startHeartbeat(d.heartbeat_interval);
      if (isResuming && state.sessionId && seq) { resume(); }
      else { identify().catch(e => console.error('[yt-music-rpc] identify error:', e)); }
      break;
    case OP.HEARTBEAT_ACK: lastHeartbeatAck = true; break;
    case OP.HEARTBEAT:     sendHeartbeat(); break;
    case OP.DISPATCH:      handleDispatch(t, d); break;
    case OP.RECONNECT:     isResuming = true; ws.close(4000, 'Reconnect requested'); break;
    case OP.INVALID_SESSION:
      console.warn('[yt-music-rpc] Invalid session — re-identifying in 5s');
      isResuming = false;
      setTimeout(() => identify().catch(e => console.error(e)), 5000);
      break;
  }
}

function handleDispatch(type, data) {
  switch (type) {
    case 'READY':
      state.connected = true;
      state.sessionId = data.session_id;
      isResuming      = false;
      state.user = {
        id:            data.user.id,
        username:      data.user.username,
        discriminator: data.user.discriminator,
        avatar:        data.user.avatar,
        global_name:   data.user.global_name || data.user.username,
      };
      persist();
      console.log(`[yt-music-rpc] READY — ${state.user.global_name}`);
      pushPresence();
      broadcastState();
      break;
    case 'RESUMED':
      state.connected = true;
      isResuming      = false;
      pushPresence();
      broadcastState();
      break;
  }
}

function startHeartbeat(interval) {
  stopHeartbeat();
  const jitter = Math.floor(Math.random() * interval);
  setTimeout(() => { sendHeartbeat(); heartbeatTimer = setInterval(sendHeartbeat, interval); }, jitter);
}
function stopHeartbeat() { clearInterval(heartbeatTimer); heartbeatTimer = null; }
function sendHeartbeat() {
  if (!lastHeartbeatAck) {
    console.warn('[yt-music-rpc] No ACK — reconnecting');
    isResuming = true; ws.close(4000, 'Heartbeat timeout'); return;
  }
  lastHeartbeatAck = false;
  send({ op: OP.HEARTBEAT, d: seq });
}

async function detectBrowser() {
  const ua = navigator.userAgent;
  if (ua.includes('Firefox')) return 'Firefox';
  if (navigator.brave && typeof navigator.brave.isBrave === 'function') {
    if (await navigator.brave.isBrave()) return 'Brave';
  }
  if (navigator.userAgentData && navigator.userAgentData.brands) {
    if (navigator.userAgentData.brands.some(b => b.brand === 'Brave')) return 'Brave';
  }
  if (ua.includes('Edg/'))   return 'Edge';
  if (ua.includes('OPR/'))   return 'Opera';
  if (ua.includes('Chrome')) return 'Chrome';
  return 'Browser';
}

async function identify() {
  const browserName = await detectBrowser();
  send({
    op: OP.IDENTIFY,
    d: {
      token: state.token,
      properties: { os: 'Windows', browser: browserName, device: '' },
      presence: await buildPresencePayload(),
      compress: false,
      large_threshold: 50,
    },
  });
}

function resume() {
  send({ op: OP.RESUME, d: { token: state.token, session_id: state.sessionId, seq } });
}

async function resolveExternalAsset(url) {
  if (!url || !url.startsWith('http')) return null;
  if (state.assetCache.has(url)) return state.assetCache.get(url);
  try {
    const res = await fetch('https://discord.com/api/v10/applications/463151177836658699/external-assets', {
      method:  'POST',
      headers: { 'Authorization': state.token, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ urls: [url] }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.length > 0 && data[0].external_asset_path) {
        const hash = `mp:${data[0].external_asset_path}`;
        state.assetCache.set(url, hash);
        return hash;
      }
    }
  } catch (err) { console.error('[yt-music-rpc] Failed to resolve external asset:', err); }
  return null;
}

async function buildPresencePayload() {
  const activities = [];
  if (state.rpcEnabled && state.currentSong) {
    const s        = state.currentSong;
    const activity = {
      name:           'YouTube Music',
      application_id: '463151177836658699',
      type:           2,
      details:        s.title  || 'Unknown Track',
      state:          s.artist || 'Unknown Artist',
    };
    let largeImageKey = null;
    if (s.albumArt) {
      const h = await resolveExternalAsset(s.albumArt);
      if (h) largeImageKey = h;
    }
    let smallImageKey = null;
    const ytLogo = 'https://raw.githubusercontent.com/walkxcode/dashboard-icons/main/png/youtube-music.png';
    const sh = await resolveExternalAsset(ytLogo);
    if (sh) smallImageKey = sh;

    activity.assets = { large_text: s.album || s.title || 'YouTube Music', small_text: 'YouTube Music' };
    if (largeImageKey) activity.assets.large_image = largeImageKey;
    if (smallImageKey) activity.assets.small_image = smallImageKey;

    const songUrl = s.videoId ? `https://music.youtube.com/watch?v=${s.videoId}` : 'https://music.youtube.com/';
    activity.buttons  = ['Listen on YouTube Music'];
    activity.metadata = { button_urls: [songUrl] };

    if (s.startTimestamp) {
      activity.timestamps = { start: s.startTimestamp };
      if (s.endTimestamp) activity.timestamps.end = s.endTimestamp;
    }
    activities.push(activity);
  }
  return {
    since:      state.status === 'idle' ? Date.now() : null,
    activities,
    status:     state.status,
    afk:        state.status === 'idle',
  };
}

async function pushPresence() {
  if (!state.connected) return;
  const payload = await buildPresencePayload();
  send({ op: OP.PRESENCE_UPDATE, d: payload });
}

function broadcastState(extra = {}) {
  browser.runtime.sendMessage({
    type:  'STATE_UPDATE',
    state: { ...getPublicState(), ...extra },
  }).catch(() => {});
}

function getPublicState() {
  return {
    // Discord
    connected:   state.connected,
    user:        state.user,
    rpcEnabled:  state.rpcEnabled,
    status:      state.status,
    currentSong: state.currentSong,
    hasToken:    !!state.token,
    // Last.fm
    lastfmKeysSet:   !!(state.lastfmApiKey && state.lastfmApiSecret),
    lastfmConnected: !!state.lastfmSessionKey,
    lastfmUsername:  state.lastfmUsername,
    lastfmEnabled:   state.lastfmEnabled,
    lastfmScrobbles: state.lastfmScrobbles,
  };
}

async function initiateLogin() {
  startWebRequestCapture();
  await browser.storage.local.set({ pendingLogin: true });
  try {
    const existing = await browser.tabs.query({ url: ['https://discord.com/*', 'https://discordapp.com/*'] });
    if (existing.length > 0) {
      loginTabId = existing[0].id;
      await browser.tabs.reload(loginTabId);
    } else {
      const tab  = await browser.tabs.create({ url: 'https://discord.com/channels/@me', active: false });
      loginTabId = tab.id;
    }
    return { ok: true };
  } catch (err) {
    stopWebRequestCapture();
    await browser.storage.local.remove('pendingLogin');
    return { ok: false, error: err.message };
  }
}

// ─── Message handler ─────────────────────────────────────────────────────────
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    // ── Discord ──────────────────────────────────────────────────────────────
    case 'SONG_UPDATE':
      state.currentSong = msg.song;
      pushPresence().catch(console.error);
      lfmUpdateNowPlaying(msg.song);
      scheduleScrobble(msg.song);
      broadcastState();
      break;

    case 'SONG_STOP':
      state.currentSong      = null;
      state.lastfmNowPlaying = null;
      clearScrobbleTimer();
      pushPresence().catch(console.error);
      broadcastState();
      break;

    case 'DISCORD_TOKEN':
      console.log('[yt-music-rpc] Got token from discord-cs.js');
      handleDiscordToken(msg.token);
      break;

    case 'GET_STATE':
      sendResponse(getPublicState());
      return true;

    case 'LOGIN':
      initiateLogin().then(sendResponse);
      return true;

    case 'LOGOUT':
      state.currentSong = null;
      disconnect(true);
      persist();
      broadcastState();
      sendResponse({ ok: true });
      return true;

    case 'TOGGLE_RPC':
      state.rpcEnabled = msg.enabled;
      persist();
      pushPresence().catch(console.error);
      broadcastState();
      break;

    case 'SET_STATUS':
      state.status = msg.status;
      persist();
      pushPresence().catch(console.error);
      broadcastState();
      break;

    // ── Last.fm ───────────────────────────────────────────────────────────────
    case 'LASTFM_LOGIN': {
      const { username, password } = msg;
      if (!state.lastfmApiKey || !state.lastfmApiSecret) {
        sendResponse({ ok: false, error: 'API keys not set. Enter your Last.fm API Key and Secret first.' });
        return true;
      }
      getMobileSession(username, password, state.lastfmApiKey, state.lastfmApiSecret)
        .then(sessionKey => {
          state.lastfmSessionKey = sessionKey;
          state.lastfmUsername   = username;
          state.lastfmEnabled    = true;
          state.lastfmScrobbles  = 0;
          state.lastfmNowPlaying = null;
          scrobbleTrackKey       = null;
          persist();
          broadcastState();
          sendResponse({ ok: true, username });
          // Immediately update nowPlaying if a track is already playing
          if (state.currentSong) {
            lfmUpdateNowPlaying(state.currentSong);
            scheduleScrobble(state.currentSong);
          }
        })
        .catch(err => {
          console.error('[lastfm] Login failed:', err);
          sendResponse({ ok: false, error: err.message });
        });
      return true;
    }

    case 'LASTFM_LOGOUT':
      state.lastfmSessionKey = null;
      state.lastfmUsername   = null;
      state.lastfmEnabled    = true;
      state.lastfmScrobbles  = 0;
      state.lastfmNowPlaying = null;
      clearScrobbleTimer();
      scrobbleTrackKey = null;
      persist();
      broadcastState();
      sendResponse({ ok: true });
      return true;

    case 'LASTFM_SAVE_KEYS': {
      const { apiKey, apiSecret } = msg;
      if (!apiKey || !apiSecret) {
        sendResponse({ ok: false, error: 'Both API Key and API Secret are required.' });
        return true;
      }
      state.lastfmApiKey    = apiKey.trim();
      state.lastfmApiSecret = apiSecret.trim();
      // If there was a previous session, clear it — keys changed so session is invalid
      state.lastfmSessionKey = null;
      state.lastfmUsername   = null;
      state.lastfmScrobbles  = 0;
      state.lastfmNowPlaying = null;
      clearScrobbleTimer();
      scrobbleTrackKey = null;
      persist();
      broadcastState();
      sendResponse({ ok: true });
      return true;
    }

    case 'TOGGLE_SCROBBLE':
      state.lastfmEnabled = msg.enabled;
      persist();
      if (state.lastfmEnabled && state.currentSong) {
        lfmUpdateNowPlaying(state.currentSong);
        scheduleScrobble(state.currentSong);
      } else if (!state.lastfmEnabled) {
        clearScrobbleTimer();
      }
      broadcastState();
      break;
  }
});

loadState().then(() => {
  console.log('[yt-music-rpc] Background started.');
  if (state.token) connect();
});
