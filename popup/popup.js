'use strict';

if (typeof browser === 'undefined') { var browser = chrome; }

const $ = (id) => document.getElementById(id);

// ─── View helpers ─────────────────────────────────────────────────────────────
function showView(name) {
  $('view-login').classList.toggle('active', name === 'login');
  $('view-main').classList.toggle('active',  name === 'main');
}

function setLoading(on) {
  $('loading-overlay').classList.toggle('hidden', !on);
}

function showError(msg) {
  const el = $('login-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 8000);
}

function showLfmError(msg) {
  const el = $('lfm-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 8000);
}

function avatarURL(user) {
  if (!user) return 'https://cdn.discordapp.com/embed/avatars/0.png';
  if (!user.avatar) {
    const idx = user.id ? Number(BigInt(user.id) >> 22n) % 6 : 0;
    return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
  }
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.webp?size=64`;
}

function fmtTime(secs) {
  if (!secs || isNaN(secs) || secs <= 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── Connection poll (while Discord token is loading) ─────────────────────────
let pollTimer = null;

function startConnectionPoll() {
  if (pollTimer) return;
  let attempts = 0;
  pollTimer = setInterval(async () => {
    attempts++;
    try {
      const s = await browser.runtime.sendMessage({ type: 'GET_STATE' });
      if (s.connected || attempts > 40) {
        stopConnectionPoll();
        render(s);
      }
    } catch { stopConnectionPoll(); }
  }, 500);
}

function stopConnectionPoll() {
  clearInterval(pollTimer);
  pollTimer = null;
}

// ─── Progress bar timer ───────────────────────────────────────────────────────
let progressTimer = null;

function startProgressTimer(song) {
  stopProgressTimer();
  function tick() {
    const now     = Date.now();
    const elapsed = Math.max(0, (now - song.startTimestamp) / 1000);
    const total   = song.endTimestamp
      ? Math.max(1, (song.endTimestamp - song.startTimestamp) / 1000)
      : song.duration || 1;
    const pct = Math.min(100, (elapsed / total) * 100);

    const bar = $('np-bar-inner');
    const el  = $('np-elapsed');
    const dur = $('np-duration');
    if (bar) bar.style.width = `${pct}%`;
    if (el)  el.textContent  = fmtTime(elapsed);
    if (dur) dur.textContent = fmtTime(total);
  }
  tick();
  progressTimer = setInterval(tick, 1000);
}

function stopProgressTimer() {
  clearInterval(progressTimer);
  progressTimer = null;
}

// ─── Main render ──────────────────────────────────────────────────────────────
function render(state) {
  const hdr = document.querySelector('.header-status');
  hdr.classList.toggle('connected', state.connected);
  $('conn-label').textContent = state.connected
    ? 'ONLINE'
    : state.hasToken ? 'CONNECTING…' : 'OFFLINE';

  if (state.loginError) showError(state.loginError);

  if (state.hasToken && !state.connected && !state.user) {
    showView('login');
    $('login-btn').style.display     = 'none';
    $('login-waiting').style.display = 'flex';
    startConnectionPoll();
    return;
  }

  if (!state.hasToken || !state.user) {
    showView('login');
    $('login-btn').style.display     = '';
    $('login-waiting').style.display = 'none';
    stopConnectionPoll();
    return;
  }

  stopConnectionPoll();
  showView('main');
  renderUser(state);
  renderControls(state);
  renderNowPlaying(state);
  renderLastFm(state);
}

function renderUser({ user, status }) {
  $('user-avatar').src       = avatarURL(user);
  $('user-name').textContent = user.global_name || user.username;
  $('user-tag').textContent  = user.discriminator && user.discriminator !== '0'
    ? `#${user.discriminator}`
    : `@${user.username}`;
  $('avatar-status-dot').className = `avatar-status ${status}`;
}

function renderControls({ rpcEnabled, playingOnly = true }) {
  $('rpc-toggle').checked          = rpcEnabled;
  $('rpc-state-label').textContent = rpcEnabled ? 'ON' : 'OFF';
  $('playing-only-toggle').checked = playingOnly;
  $('playing-only-state-label').textContent = playingOnly ? 'ON' : 'OFF';
}

function renderNowPlaying({ rpcEnabled, currentSong }) {
  const song = rpcEnabled ? currentSong : null;

  const npContent  = $('np-content');
  const npProgress = $('np-progress-wrap');
  const npIdle     = $('np-idle');

  if (!song) {
    npContent.style.display  = 'none';
    npProgress.style.display = 'none';
    npIdle.style.display     = 'flex';
    $('preview-song').textContent   = '—';
    $('preview-artist').textContent = '—';
    stopProgressTimer();
    return;
  }

  npContent.style.display  = 'flex';
  npProgress.style.display = 'flex';
  npIdle.style.display     = 'none';

  const artEl = $('np-art');
  const artPh = $('np-art-placeholder');
  if (song.albumArt) {
    artEl.src = song.albumArt;
    artEl.classList.add('loaded');
    artPh.style.display = 'none';
  } else {
    artEl.classList.remove('loaded');
    artPh.style.display = 'flex';
  }

  $('np-title').textContent  = song.title  || '—';
  $('np-artist').textContent = song.artist || '—';
  $('np-album').textContent  = song.album  || '';

  $('preview-song').textContent   = song.title  || '—';
  $('preview-artist').textContent = song.artist || '—';

  startProgressTimer(song);
}

// ─── Last.fm render ───────────────────────────────────────────────────────────
function renderLastFm({ lastfmKeysSet, lastfmConnected, lastfmUsername, lastfmEnabled, lastfmScrobbles, currentSong }) {
  const keysForm      = $('lfm-keys-form');
  const loginForm     = $('lfm-login-form');
  const connectedView = $('lfm-connected-view');
  const badge         = $('lfm-badge');

  if (lastfmConnected) {
    // ── Connected: hide both forms, show connected view ──
    keysForm.classList.add('hidden');
    loginForm.classList.add('hidden');
    connectedView.classList.remove('hidden');

    $('lfm-connected-name').textContent  = lastfmUsername || '';
    $('scrobble-toggle').checked         = lastfmEnabled;
    $('scrobble-state-label').textContent = lastfmEnabled ? 'ON' : 'OFF';

    // Scrobble count badge
    if (lastfmScrobbles > 0) {
      badge.textContent = `${lastfmScrobbles} scrobble${lastfmScrobbles !== 1 ? 's' : ''}`;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }

    // "Now playing" status label
    const label = $('lfm-now-playing-label');
    if (lastfmEnabled && currentSong) {
      label.textContent = `◎ NOW PLAYING ON LAST.FM`;
      label.style.color = 'var(--amber)';
    } else if (!lastfmEnabled) {
      label.textContent = 'scrobbling paused';
      label.style.color = '';
    } else {
      label.textContent = 'waiting for track…';
      label.style.color = '';
    }
  } else if (lastfmKeysSet) {
    // ── Keys saved, not yet logged in: show login form ──
    keysForm.classList.add('hidden');
    loginForm.classList.remove('hidden');
    connectedView.classList.add('hidden');
    badge.classList.add('hidden');
  } else {
    // ── No keys yet: show key entry form ──
    keysForm.classList.remove('hidden');
    loginForm.classList.add('hidden');
    connectedView.classList.add('hidden');
    badge.classList.add('hidden');
  }
}

// ─── Login view wiring ────────────────────────────────────────────────────────
function initLoginView() {
  $('login-btn').addEventListener('click', async () => {
    $('login-error').classList.add('hidden');
    $('login-btn').disabled = true;

    const result = await browser.runtime.sendMessage({ type: 'LOGIN' }).catch(err => ({
      ok: false,
      error: `Extension background error: ${err.message || err}`,
    }));

    if (!result || !result.ok) {
      $('login-btn').disabled = false;
      showError(result?.error || 'Could not open Discord tab.');
      return;
    }

    $('login-btn').style.display     = 'none';
    $('login-waiting').style.display = 'flex';
    startConnectionPoll();
  });
}

// ─── Main view wiring ─────────────────────────────────────────────────────────
function initMainView() {
  $('rpc-toggle').addEventListener('change', (e) => {
    $('rpc-state-label').textContent = e.target.checked ? 'ON' : 'OFF';
    browser.runtime.sendMessage({ type: 'TOGGLE_RPC', enabled: e.target.checked });
  });

  $('playing-only-toggle').addEventListener('change', (e) => {
    $('playing-only-state-label').textContent = e.target.checked ? 'ON' : 'OFF';
    browser.runtime.sendMessage({ type: 'TOGGLE_PLAYING_ONLY', enabled: e.target.checked });
  });

  $('logout-btn').addEventListener('click', async () => {
    if (!confirm('Disconnect from Discord?')) return;
    await browser.runtime.sendMessage({ type: 'LOGOUT' });
    const s = await browser.runtime.sendMessage({ type: 'GET_STATE' });
    render(s);
  });
}

// ─── Last.fm wiring ───────────────────────────────────────────────────────────
function initLastFm() {

  // ── Save API Keys ────────────────────────────────────────────────────────
  $('lfm-save-keys-btn').addEventListener('click', async () => {
    const apiKey    = $('lfm-api-key').value.trim();
    const apiSecret = $('lfm-api-secret').value.trim();

    if (!apiKey || !apiSecret) {
      const el = $('lfm-keys-error');
      el.textContent = 'Both API Key and API Secret are required.';
      el.classList.remove('hidden');
      setTimeout(() => el.classList.add('hidden'), 6000);
      return;
    }

    $('lfm-save-keys-btn').disabled = true;
    $('lfm-save-keys-btn').textContent = 'SAVING…';
    $('lfm-keys-error').classList.add('hidden');

    const result = await browser.runtime.sendMessage({
      type: 'LASTFM_SAVE_KEYS',
      apiKey,
      apiSecret,
    }).catch(err => ({ ok: false, error: err.message }));

    $('lfm-save-keys-btn').disabled = false;
    $('lfm-save-keys-btn').textContent = 'SAVE API KEYS ›';

    if (!result?.ok) {
      const el = $('lfm-keys-error');
      el.textContent = result?.error || 'Failed to save keys.';
      el.classList.remove('hidden');
      setTimeout(() => el.classList.add('hidden'), 6000);
      return;
    }

    // Clear inputs and re-render
    $('lfm-api-key').value    = '';
    $('lfm-api-secret').value = '';
    const s = await browser.runtime.sendMessage({ type: 'GET_STATE' });
    renderLastFm(s);
  });

  // ── Change Keys buttons (login form & connected view) ────────────────────
  function showKeysForm() {
    $('lfm-keys-form').classList.remove('hidden');
    $('lfm-login-form').classList.add('hidden');
    $('lfm-connected-view').classList.add('hidden');
  }
  $('lfm-change-keys-btn').addEventListener('click', showKeysForm);
  $('lfm-change-keys-btn-conn').addEventListener('click', () => {
    if (!confirm('Changing API keys will disconnect your Last.fm account. Continue?')) return;
    showKeysForm();
  });

  // ── Connect (username + password) ────────────────────────────────────────
  $('lfm-connect-btn').addEventListener('click', async () => {
    const username = $('lfm-username').value.trim();
    const password = $('lfm-password').value;

    if (!username || !password) {
      showLfmError('Please enter your Last.fm username and password.');
      return;
    }

    $('lfm-connect-btn').disabled = true;
    $('lfm-connect-btn').textContent = 'CONNECTING…';
    $('lfm-error').classList.add('hidden');

    const result = await browser.runtime.sendMessage({
      type: 'LASTFM_LOGIN',
      username,
      password,
    }).catch(err => ({ ok: false, error: err.message }));

    $('lfm-connect-btn').disabled = false;
    $('lfm-connect-btn').textContent = 'CONNECT LAST.FM ›';

    if (!result?.ok) {
      showLfmError(result?.error || 'Login failed. Check your credentials.');
      return;
    }

    // Clear sensitive fields immediately
    $('lfm-password').value = '';
    const s = await browser.runtime.sendMessage({ type: 'GET_STATE' });
    renderLastFm(s);
  });

  // Allow Enter key to submit on both forms
  [$('lfm-username'), $('lfm-password')].forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('lfm-connect-btn').click();
    });
  });
  [$('lfm-api-key'), $('lfm-api-secret')].forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('lfm-save-keys-btn').click();
    });
  });

  // ── Disconnect ───────────────────────────────────────────────────────────
  $('lfm-disconnect-btn').addEventListener('click', async () => {
    if (!confirm('Disconnect Last.fm? Scrobbling will stop.')) return;
    await browser.runtime.sendMessage({ type: 'LASTFM_LOGOUT' });
    const s = await browser.runtime.sendMessage({ type: 'GET_STATE' });
    renderLastFm(s);
  });

  // ── Scrobble toggle ──────────────────────────────────────────────────────
  $('scrobble-toggle').addEventListener('change', (e) => {
    $('scrobble-state-label').textContent = e.target.checked ? 'ON' : 'OFF';
    browser.runtime.sendMessage({ type: 'TOGGLE_SCROBBLE', enabled: e.target.checked });
  });
}

// ─── Message listener (background → popup) ────────────────────────────────────
browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATE_UPDATE') render(msg.state);
});

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const savedTheme = localStorage.getItem('yt-music-rpc_theme');
  if (savedTheme === 'light') document.body.classList.add('theme-light');

  $('theme-toggle').addEventListener('click', () => {
    document.body.classList.toggle('theme-light');
    const isLight = document.body.classList.contains('theme-light');
    localStorage.setItem('yt-music-rpc_theme', isLight ? 'light' : 'dark');
  });

  initLoginView();
  initMainView();
  initLastFm();

  setLoading(true);
  try {
    const s = await browser.runtime.sendMessage({ type: 'GET_STATE' });
    render(s);
    if (s.hasToken && !s.connected) startConnectionPoll();
  } catch (err) {
    console.error('[yt-music-rpc]', err);
    render({ connected: false, hasToken: false });
  }
  setLoading(false);
}

init();
