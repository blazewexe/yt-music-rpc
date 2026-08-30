'use strict';

// MV3 service worker entry point.
// importScripts loads both files into the same global scope,
// preserving the MV2 behaviour where background.js calls
// functions defined in lastfm.js directly.
importScripts('lastfm.js', 'background.js');
