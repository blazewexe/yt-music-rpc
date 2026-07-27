# <p align="center"><img src="icons/icon-128.png" width="48" height="48" valign="middle"> yt-music-rpc</p>

<p align="center">
  <strong>YouTube Music ➜ Discord Rich Presence</strong><br />
  <em>A lightweight browser extension for Firefox & Chromium-based browsers. No desktop client, bridge, or native app required.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Version-1.1.0-blue?style=for-the-badge" alt="Version 1.1.0" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="MIT License" />
  <img src="https://img.shields.io/badge/Platform-Cross--Browser-orange?style=for-the-badge" alt="Cross Browser" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Firefox-Supported-orange?style=flat-square&logo=firefox-browser&logoColor=white" />
  <img src="https://img.shields.io/badge/Chrome-Supported-blue?style=flat-square&logo=google-chrome&logoColor=white" />
  <img src="https://img.shields.io/badge/Brave-Supported-red?style=flat-square&logo=brave&logoColor=white" />
  <img src="https://img.shields.io/badge/Edge-Supported-blueviolet?style=flat-square&logo=microsoft-edge&logoColor=white" />
  <img src="https://img.shields.io/badge/Opera-Supported-red?style=flat-square&logo=opera&logoColor=white" />
</p>

---

## Features

*   **Listening Status** — Shows up on your Discord profile as "Listening to YouTube Music" (just like official Spotify integration).
*   **Track Metadata** — Displays current song title, artist, and album.
*   **Dynamic Artwork** — Fetches and displays high-quality album art directly from YouTube Music's CDN.
*   **Live Progress** — Synchronizes start and end timestamps so your status bar tracks the song length in real time.
*   **Zero-Config Login** — Automatically detects your active Discord session in the browser to connect. No pasting credentials or client IDs.
*   **Minimalist Dot-Matrix UI** — A beautiful Nothing-brand inspired retro UI with dark/light themes.

---

## Installation

### Firefox
1. Open Firefox and navigate to `about:debugging`
2. Click **This Firefox** on the left menu.
3. Click **Load Temporary Add-on...**
4. Select the `manifest.json` file inside this repository.
5. The extension icon will appear in your toolbar.

### Chrome / Edge / Brave / Opera
1. Open your browser and head to the extensions page (e.g. `chrome://extensions` or `brave://extensions`).
2. Toggle **Developer mode** in the top-right corner.
3. Click the **Load unpacked** button in the top-left.
4. Select this project's root folder.
5. Pin the extension to your toolbar.

---

## First-Time Setup

1. Click the **yt-music-rpc** toolbar icon to open the popup.
2. Ensure you are logged into [discord.com](https://discord.com) in this browser profile.
3. Click the **CONNECT TO DISCORD ›** button.
4. A Discord tab will open in the background to automatically authorize the session and will close after 3 seconds.
5. Return to the popup UI. You are now fully connected!
6. Navigate to [music.youtube.com](https://music.youtube.com) and start playing music to see it update.

---

## Architecture

The extension runs entirely client-side without any third-party databases:

```
yt-music-rpc/
├── background.js   # Manages heartbeat and gateway WS connection directly to Discord
├── content.js      # Scrapes YouTube Music player via MediaSession & <video> events
├── discord-cs.js   # Local token extractor fallback for authentication
└── popup/
    ├── popup.html     # Dot-matrix user interface
    ├── popup.js       # Live state synchronization and connection triggers
    └── popup.css      # Custom retro styling with responsive themes
```

---

## Disclaimer

> [!WARNING]
> Logging in to Discord's Gateway with a user token to set custom activity presence ("self-botting") is technically outside Discord's official Terms of Service. This extension is an open-source, client-side personal tool. Use at your own discretion.
