/**
 * BSFC Web Photobooth — Kiosk Configuration
 * ---------------------------------------------------------------------------
 * Edit this file to customize store PIN, timers, Epson TM-T20III / RawBT
 * settings, SMS API endpoint, and playful food/community pose prompts.
 */
window.BSFC_CONFIG = {
  // 4-digit Admin Menu PIN (matches store register code)
  adminPin: "2010",

  // Kiosk timing (seconds)
  inactivityTimeoutSec: 60, // Reset to Attract screen after 60s of no input
  printCooldownSec: 120,    // 2-minute cooldown between physical prints
  countdownSec: 3,          // 3-second photo capture countdown
  maxRetakes: 1,            // Users get 1 retake before final confirmation

  // Audio feedback (synthesized locally via Web Audio API, no audio files needed)
  soundEnabled: true,

  // Thermal printer configuration (Epson TM-T20III, 80mm paper)
  printer: {
    // "auto" tries RawBT WebSocket -> Web Bluetooth -> Backend Relay -> RawBT Intent
    // Set to "simulator" during MacBook UI testing without hardware attached.
    mode: "auto",

    // Epson TM-T20III printable width on 80mm thermal roll (203 DPI = 576 dots)
    paperWidthPx: 576,

    // Dithering algorithm for portraits: "atkinson" (best for faces) or "floyd-steinberg"
    ditherMethod: "atkinson",

    // Portrait tone tuning before dithering so faces stay bright & clear on thermal paper
    contrast: 1.16,
    brightness: 10,
    gamma: 1.08,

    // RawBT Android local WebSocket print server (enable WebSocket server in RawBT settings)
    rawbtWsUrl: "ws://localhost:40213/",
    rawbtWsTimeoutMs: 2500,

    // Fallback to Android rawbt:base64 intent URI on Android tablets if WS isn't running
    rawbtIntentFallback: true,

    // Web Bluetooth GATT UUIDs (standard ESC/POS / serial BLE services)
    bluetoothServiceUuids: [
      "000018f0-0000-1000-8000-00805f9b34fb",
      "49535343-fe7d-4ae5-8fa9-9fafd205e455",
      "e7810a71-73ae-499d-8c15-faa9aef0c3f2"
    ],
    bluetoothCharUuids: [
      "00002af1-0000-1000-8000-00805f9b34fb",
      "49535343-8841-43f4-a8d4-ecbe34729bb3",
      "bef8d6c9-9c21-4c9e-b632-bd58c1009f9f"
    ],

    // Optional backend network/USB print relay endpoint (server.py)
    backendRelayEndpoint: "/api/print",
    feedLinesAfterPrint: 4,
    autoCut: true
  },

  // Digital delivery & backend endpoints
  sharing: {
    photoUploadEndpoint: "/api/photos",
    smsEndpoint: "/api/sms",
    // Leave empty to use current browser origin (e.g. http://192.168.x.x:8080)
    publicBaseUrl: "",
    // Fallback URL encoded into QR if backend server is unreachable
    fallbackQrUrl: "https://www.instagram.com/bsfcollective/"
  },

  // Storefront branding (matches printed layout.jpg)
  branding: {
    storeName: "Berkeley Student Food Collective",
    tagline: "too good not to snap",
    handle: "@bsfcollective",
    address: "2440 Bancroft Way #102, Berkeley, CA 94704",
    consentNotice:
      "By taking a photo, you agree that your photo may be displayed on the BSFC community wall inside the storefront or shared on BSFC social media channels (@bsfcollective)."
  },

  // Randomized whimsical food & co-op pose prompts
  prompts: [
    "Show us your best ripe avocado face!",
    "Strike a pose like your favorite leafy green!",
    "Give a big thumbs-up for student-run groceries!",
    "Pretend you just found the last mango in the bin!",
    "Kombucha cheers! Raise an imaginary bottle!",
    "Channel your inner fresh-baked sourdough!",
    "Give your most dramatic chef's kiss!",
    "Squish together like berries in a pint!",
    "Act amazed by the bulk bin oat prices!",
    "Make a heart with your hands for the Co-op!",
    "Flash your brightest farmers-market smile!",
    "Tiny bite face — pretend you're tasting a crisp apple!",
    "Strike a superhero pose for local organic produce!",
    "Two-finger peace signs for Berkeley Co-op love!",
    "Look as happy as trail mix in the bulk aisle!",
    "Silliest grin on Bancroft Way — get ready!"
  ]
};
