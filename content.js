'use strict';

if (typeof browser === 'undefined') { var browser = chrome; }

let lastTitle    = null;
let lastPlaying  = null;
let video        = null;
let pollTimer    = null;
let metaObserver = null;

function getVideo() {
  return document.querySelector('video');
}

function isActuallyPlaying(vid) {
  return vid
    && !vid.paused
    && !vid.ended
    && vid.readyState > 2
    && !isNaN(vid.duration)
    && vid.duration > 0;
}

function buildSongData() {
  const meta = navigator.mediaSession?.metadata;
  if (!meta || !meta.title) return null;

  const vid         = getVideo();
  const currentTime = vid ? vid.currentTime : 0;
  const duration    = vid ? vid.duration    : NaN;
  const videoId     = new URLSearchParams(window.location.search).get('v');

  let albumArt = null;

  if (meta.artwork && meta.artwork.length > 0) {
    const sorted = [...meta.artwork].sort((a, b) => {
      const sizeA = parseInt((a.sizes || '0x0').split('x')[0], 10) || 0;
      const sizeB = parseInt((b.sizes || '0x0').split('x')[0], 10) || 0;
      return sizeB - sizeA;
    });
    albumArt = sorted[0].src || null;
    if (albumArt && albumArt.includes('googleusercontent.com') && albumArt.includes('=w')) {
      albumArt = albumArt.replace(/=[^=]*$/, '=w512-h512');
    }
  }

  if (!albumArt && videoId) {
    albumArt = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  }

  const now            = Date.now();
  const startTimestamp = Math.round(now - currentTime * 1000);
  const endTimestamp   = (!isNaN(duration) && duration > 0)
    ? Math.round(now + (duration - currentTime) * 1000)
    : null;

  return {
    title:          meta.title,
    artist:         meta.artist  || null,
    album:          meta.album   || null,
    albumArt,
    videoId,
    currentTime:    Math.floor(currentTime),
    duration:       (!isNaN(duration) && duration > 0) ? Math.floor(duration) : null,
    startTimestamp,
    endTimestamp,
  };
}

function sendUpdate(song) {
  browser.runtime.sendMessage({ type: 'SONG_UPDATE', song }).catch(() => {});
}

function sendStop() {
  browser.runtime.sendMessage({ type: 'SONG_STOP' }).catch(() => {});
}

window.addEventListener('pagehide', sendStop, { once: true });

function check() {
  const vid     = getVideo();
  const playing = isActuallyPlaying(vid);
  const song    = playing ? buildSongData() : null;

  if (!song) {
    if (lastPlaying !== false) {
      lastPlaying = false;
      lastTitle   = null;
      sendStop();
    }
    return;
  }

  const titleChanged = song.title !== lastTitle;

  if (!titleChanged && lastPlaying === true) return;

  lastPlaying = true;
  lastTitle   = song.title;
  sendUpdate(song);
}

function refreshTimestamps() {
  if (lastPlaying !== true) return;
  const vid = getVideo();
  if (!isActuallyPlaying(vid)) return;
  const song = buildSongData();
  if (song) sendUpdate(song);
}

function attachVideoListeners(vid) {
  if (video === vid) return;
  video = vid;

  vid.addEventListener('play',           onPlay,     { passive: true });
  vid.addEventListener('pause',          onPause,    { passive: true });
  vid.addEventListener('ended',          onPause,    { passive: true });
  vid.addEventListener('emptied',        onPause,    { passive: true });
  vid.addEventListener('loadedmetadata', onNewTrack, { passive: true });
}

function onPlay() {
  setTimeout(check, 150);
}

function onPause() {
  lastPlaying = false;
  lastTitle   = null;
  sendStop();
}

function onNewTrack() {
  lastTitle   = null;
  lastPlaying = null;
  setTimeout(check, 300);
}

function injectMetaWatcher() {
  const script = document.createElement('script');
  script.textContent = `(function() {
    const proto = MediaSession.prototype;
    const desc  = Object.getOwnPropertyDescriptor(proto, 'metadata');
    if (!desc || !desc.set) return;
    Object.defineProperty(proto, 'metadata', {
      get: desc.get,
      set(val) {
        desc.set.call(this, val);
        window.postMessage({ __yt_music_rpc: true, event: 'metaChange' }, '*');
      },
      configurable: true,
    });
  })();`;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

window.addEventListener('message', (ev) => {
  if (ev.source === window && ev.data?.__yt_music_rpc && ev.data.event === 'metaChange') {
    lastTitle   = null;
    lastPlaying = null;
    setTimeout(check, 250);
  }
}, { passive: true });

function observeForVideo() {
  if (metaObserver) return;

  metaObserver = new MutationObserver(() => {
    const vid = getVideo();
    if (vid && vid !== video) attachVideoListeners(vid);
  });

  metaObserver.observe(document.body, { childList: true, subtree: true });
}

function init() {
  injectMetaWatcher();
  observeForVideo();

  const vid = getVideo();
  if (vid) attachVideoListeners(vid);

  pollTimer = setInterval(refreshTimestamps, 15_000);

  setTimeout(check, 1000);
  setTimeout(check, 3000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
