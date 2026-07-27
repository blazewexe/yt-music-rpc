'use strict';

if (typeof browser === 'undefined') { var browser = chrome; }

async function extractToken() {
  const { pendingLogin } = await browser.storage.local.get('pendingLogin');
  if (!pendingLogin) return;

  await new Promise(r => setTimeout(r, 1200));

  let token = null;
  const stores = [];

  if (window.wrappedJSObject) {
    try { stores.push(window.wrappedJSObject.localStorage); }   catch (_) {}
    try { stores.push(window.wrappedJSObject.sessionStorage); } catch (_) {}
  }

  try { stores.push(window.localStorage); }   catch (_) {}
  try { stores.push(window.sessionStorage); } catch (_) {}

  const KEYS = ['token', 'discordToken', 'authToken', 'auth_token'];

  outer:
  for (const store of stores) {
    if (!store) continue;
    for (const key of KEYS) {
      try {
        let raw = store.getItem(key);
        if (!raw) continue;
        raw = raw.replace(/^"|"$/g, '').trim();
        if (raw.length > 20) { token = raw; break outer; }
      } catch (_) {}
    }
  }

  console.log('[yt-music-rpc] Token via localStorage:', !!token);

  if (token) {
    browser.runtime.sendMessage({ type: 'DISCORD_TOKEN', token });
  } else {
    console.log('[yt-music-rpc] No token in storage — webRequest capture should handle it.');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', extractToken, { once: true });
} else {
  extractToken();
}
