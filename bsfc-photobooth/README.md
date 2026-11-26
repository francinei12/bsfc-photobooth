# Berkeley Student Food Collective (BSFC) Web Photobooth

A responsive, kiosk-ready web photobooth built for the **Berkeley Student Food Collective** storefront (`2440 Bancroft Way #102, Berkeley, CA 94704`), styled after classic retro Photo Booth and designed to run **100% free ($0 software cost, zero watermarks, zero subscriptions)** on a **Samsung Galaxy Tab A9+** paired with an **Epson TM-T20III** 80mm thermal receipt printer.

---

## Is Everything Free? (Zero-Cost vs. Optional Paid Apps)

You **do not** need to pay for any app or subscription to run this photobooth cleanly without watermarks:

| Need | Paid / Freemium App | **100% Free ($0) Built-In Alternative** |
| :--- | :--- | :--- |
| **Kiosk Lockdown** | *Fully Kiosk Browser* (free trial shows watermarks/nags; PLUS license is ~$10.99/device) | **Chrome PWA Fullscreen + Android Built-in App Pinning** (`manifest.json` + Samsung Settings, **$0**, zero watermarks) |
| **Thermal Printing** | *RawBT* (free version prints a RawBT notice at the bottom of receipts unless licensed) | **WebUSB Direct USB-OTG** (built into Chrome via `printer.js`), **Port 9100 LAN Relay** (built into `server.py`), or **Web Bluetooth** (**$0**, zero watermarks) |
| **Digital Sharing** | *Twilio SMS* (paid per text + phone number) | **QR Code Instant Download** (`/s/<id>`) + **Free Email Delivery** (built into `server.py` using any Gmail App Password, **$0**) |

---

## Files Overview

| File | Purpose |
| :--- | :--- |
| `index.html` | Kiosk UI shell, 5-screen flow, `?` help modal, hidden 4-digit PIN pad, Admin Panel, and Sleep overlay |
| `manifest.json` / `icon.svg` | Progressive Web App (PWA) manifest for **$0 fullscreen Chrome installation** on Android |
| `styles.css` | Retro coral Photo Booth frame, animations, receipt feeding animation, and responsive tablet/desktop styling |
| `config.js` | Central configuration: 4-digit admin PIN (`2010`), 60s inactivity timeout, 120s cooldown, printer settings, pose prompts |
| `qrcode.js` | Zero-dependency pure JS QR code generator (ISO/IEC 18004 Byte mode) for offline/kiosk reliability |
| `assets.js` | Vector BSFC lips logo, photostrip compositor (`printed layout.jpg`), Atkinson & Floyd-Steinberg dithering |
| `printer.js` | Epson TM-T20III 80mm ESC/POS raster driver (`GS v 0`) for **WebUSB (Free)**, **Port 9100 Relay (Free)**, **Web Bluetooth (Free)**, RawBT, & Simulator |
| `app.js` | Complete kiosk state machine, camera capture, 1-retake tabbed review, cooldown & 60s inactivity watchdog |
| `server.py` | Lightweight Python 3 backend (stdlib only) for static hosting, `/s/<id>` QR download pages, free SMTP email / optional Twilio SMS, and port-9100 print relay |

---

## 1. MacBook Local Testing Setup

1. **Ensure Python 3 is available:**
   On macOS, if `python3` prompts for Xcode Command Line Tools, install them via:
   ```bash
   xcode-select --install
   ```
2. **Start the photobooth server:**
   ```bash
   cd /Users/francineimperial/.gemini/antigravity/scratch/bsfc-photobooth
   python3 server.py
   ```
3. **Open in Chrome on your MacBook:**
   Visit `http://localhost:8080`
   - `localhost` is treated as a secure origin, so `getUserMedia` front-camera access works immediately.
   - Without a webcam, click **Use Demo Snapshot** on the camera screen.
4. **Enable Mac Simulator Mode (no thermal printer attached):**
   - Tap the **top-left corner** of the rainbow `"Photobooth"` header **5 times rapidly** (or press-and-hold for **1.6 seconds**).
   - Enter the default 4-digit PIN: `2010` (configurable in `config.js`).
   - Switch **Transport Mode** to **Mac/UI Simulator Mode**.

---

## 2. 100% Free ($0) Android Tablet Deployment (Samsung Galaxy Tab A9+)

### A. Host the Website Locally on the Tablet (`$0`)
1. Install **Termux** (free & open-source via F-Droid / GitHub) on the Galaxy Tab A9+, then run:
   ```bash
   pkg install python
   python3 server.py
   ```
   *(Or host `server.py` on a store computer/Raspberry Pi behind free HTTPS, e.g., Caddy or Tailscale Serve, so Chrome allows camera access over LAN).*

### B. Free Fullscreen Kiosk Mode (No Paid App Needed)
1. Open `http://localhost:8080` in **Google Chrome** on the Galaxy Tab A9+.
2. Tap Chrome's `⋮` menu → **Add to Home screen** → **Install** (uses `manifest.json` `"display": "fullscreen"` to hide the address bar completely for **$0**).
3. On your Samsung Galaxy Tab A9+, enable built-in kiosk lock:
   - Open **Settings → Security and privacy → More security settings → Pin app** → turn **ON** (and turn ON **Ask for PIN before unpinning**).
4. Launch the **BSFC Booth** icon from the home screen, open Recent Apps (`|||`), tap the app icon at the top of its card, and select **Pin this app**. Guests cannot exit the photobooth without the tablet PIN!

### C. Free Watermark-Free Printing to Epson TM-T20III (No RawBT Needed)
Choose either **$0 direct option**:
- **Option 1 — WebUSB Direct USB-OTG Cable (Recommended):**
  1. Connect the **Epson TM-T20III** to the Samsung Galaxy Tab A9+ using a **USB-B to USB-C OTG cable** (or USB-A-to-C adapter).
  2. Open the hidden Admin Menu (`2010`) → tap **Pair USB Printer (Free)** → select your Epson TM-T20III in the Chrome prompt.
  3. Tap **Run Test Print**. Chrome remembers the USB device permission across reboots and prints directly with **zero third-party apps and zero watermarks**.
- **Option 2 — Network / Ethernet Port 9100:**
  1. Connect the Epson TM-T20III to your store router, find its local IP, and start `server.py` with:
     ```bash
     export BSFC_PRINTER_IP="192.168.1.200"
     python3 server.py
     ```
  2. Set Transport Mode to **Auto** or **Backend Network Relay**.

*(RawBT WebSocket and Android Intent remain built into `printer.js` as optional fallbacks if you ever choose to use RawBT.)*

---

## 3. Free Digital Delivery (QR Code + Optional Free Email)

- **QR Code Download (`/s/<id>`):** Works automatically at **$0**. Set `sharing.publicBaseUrl` in `config.js` to your store LAN IP or domain if phones scan from store Wi-Fi.
- **Free Email Delivery (Gmail App Password, `$0`):** Guests can type an email address into the *"Text or email me my photo strip"* box. To send live emails with the PNG attached at zero cost:
  ```bash
  export SMTP_USER="your-bsfc-gmail@gmail.com"
  export SMTP_PASS="your-16-char-gmail-app-password"
  python3 server.py
  ```
- **Optional Twilio SMS (Paid per text):** If you later want real SMS texting, set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER` before starting `server.py`. Without credentials, SMS entries safely log in demo stub mode (`data/sms_log.jsonl`) at `$0`.

---

## 4. Hidden Admin Menu Reference

- **How to open:** Tap the **top-left corner** of the rainbow header **5 times quickly** (or **press & hold for 1.6s**). Works even while Sleep Mode is active.
- **Default PIN:** `2010` (edit `adminPin` in `config.js` to match your store register code).
- **Controls:** Sleep/Maintenance Mode toggle, Cooldown Override/Reset, Toggle Fullscreen, Pair USB Printer (Free), Pair Bluetooth, Check Printer, Run Test Print, and Simulate Printer Offline.
