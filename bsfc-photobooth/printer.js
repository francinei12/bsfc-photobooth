/**
 * BSFC Thermal Printer Driver (Epson TM-T20III · 80mm / 576px · ESC/POS)
 * ---------------------------------------------------------------------------
 * Modular transport layer supporting:
 *   1. RawBT Local WebSocket Bridge (ws://localhost:40213/)
 *   2. RawBT Android Intent URI (rawbt:base64,...)
 *   3. Web Bluetooth (GATT ESC/POS / serial bridge)
 *   4. Backend Network/USB Relay (POST /api/print)
 *   5. Mac / Headless Simulator Mode (plus Admin error-simulation toggle)
 */
(function (global) {
  "use strict";

  const state = {
    usbDevice: null,
    usbInterfaceNumber: null,
    usbEndpointOut: null,
    bleDevice: null,
    bleCharacteristic: null,
    simulateError: false,
    lastStatus: "Unknown",
    logs: []
  };

  function log(msg) {
    const stamp = new Date().toLocaleTimeString();
    const line = `[${stamp}] ${msg}`;
    state.logs.push(line);
    if (state.logs.length > 30) state.logs.shift();
    console.info("[BSFCPrinter]", msg);
  }

  function getConfig() {
    return (global.BSFC_CONFIG && global.BSFC_CONFIG.printer) || {};
  }

  /**
   * Encodes a monochrome/dithered HTMLCanvasElement into raw ESC/POS bytes:
   *   ESC @ (init)
   *   GS v 0 (raster bit image, 1 bit/pixel, MSB first)
   *   ESC d n (feed lines)
   *   GS V 66 0 (partial cut)
   */
  function canvasToEscPos(canvas) {
    const cfg = getConfig();
    const width = canvas.width;
    const height = canvas.height;
    const ctx = canvas.getContext("2d");
    const { data } = ctx.getImageData(0, 0, width, height);

    const bytesPerRow = Math.ceil(width / 8);
    const xL = bytesPerRow & 0xff;
    const xH = (bytesPerRow >> 8) & 0xff;
    const yL = height & 0xff;
    const yH = (height >> 8) & 0xff;

    const rasterSize = bytesPerRow * height;
    const feedLines = cfg.feedLinesAfterPrint != null ? cfg.feedLinesAfterPrint : 4;
    const cutBytes = cfg.autoCut !== false ? [0x1d, 0x56, 0x42, 0x00] : [];

    // Header: ESC @ (2) + ESC a 1 center (3) + GS v 0 header (8)
    const header = [
      0x1b, 0x40,
      0x1b, 0x61, 0x01,
      0x1d, 0x76, 0x30, 0x00, xL, xH, yL, yH
    ];
    const footer = [0x1b, 0x64, feedLines & 0xff, ...cutBytes];

    const out = new Uint8Array(header.length + rasterSize + footer.length);
    out.set(header, 0);

    let offset = header.length;
    for (let y = 0; y < height; y++) {
      for (let bx = 0; bx < bytesPerRow; bx++) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit++) {
          const x = bx * 8 + bit;
          if (x < width) {
            const p = (y * width + x) * 4;
            const lum = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
            if (lum < 128) {
              byte |= 1 << (7 - bit);
            }
          }
        }
        out[offset++] = byte;
      }
    }

    out.set(footer, offset);
    return out;
  }

  function uint8ToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  /**
   * Transport 0: WebUSB Direct USB-OTG / USB Cable (100% Free, Zero Third-Party Apps)
   * Works in Chrome on Android (USB-OTG to Epson TM-T20III) and Mac/Linux Chrome.
   */
  async function openUsbDevice(device) {
    await device.open();
    if (device.configuration === null) {
      await device.selectConfiguration(1);
    }
    let ifaceNum = null;
    let outEp = null;
    for (const iface of device.configuration.interfaces) {
      for (const alt of iface.alternates) {
        const ep = alt.endpoints.find((e) => e.direction === "out" && e.type === "bulk");
        if (ep) {
          ifaceNum = iface.interfaceNumber;
          outEp = ep.endpointNumber;
          break;
        }
      }
      if (ifaceNum !== null) break;
    }
    if (ifaceNum === null || outEp === null) {
      throw new Error("No bulk OUT USB endpoint found on printer");
    }
    await device.claimInterface(ifaceNum);
    state.usbDevice = device;
    state.usbInterfaceNumber = ifaceNum;
    state.usbEndpointOut = outEp;
    state.lastStatus = `USB Connected (${device.productName || "Epson TM-T20III"})`;
    log(state.lastStatus);
    return device.productName || "USB Thermal Printer";
  }

  async function pairUsb() {
    if (!navigator.usb) {
      throw new Error("WebUSB is not supported in this browser (use Chrome)");
    }
    let device;
    try {
      // Epson Vendor ID 0x04B8 (1208)
      device = await navigator.usb.requestDevice({
        filters: [{ vendorId: 0x04b8 }]
      });
    } catch (err) {
      // Allow choosing generic USB thermal printer if user cancelled or uses non-Epson bridge
      if (err && err.name === "NotFoundError") {
        device = await navigator.usb.requestDevice({ filters: [] });
      } else {
        throw err;
      }
    }
    return await openUsbDevice(device);
  }

  async function reconnectUsb() {
    if (!navigator.usb) return false;
    try {
      const devices = await navigator.usb.getDevices();
      const target = devices.find((d) => d.vendorId === 0x04b8) || devices[0];
      if (!target) return false;
      await openUsbDevice(target);
      return true;
    } catch (err) {
      log(`USB auto-reconnect skipped: ${err.message}`);
      return false;
    }
  }

  async function sendViaWebUsb(escPosBytes) {
    if (!state.usbDevice || !state.usbDevice.opened || state.usbEndpointOut === null) {
      const reconnected = await reconnectUsb();
      if (!reconnected) {
        throw new Error("USB printer not paired (click Pair USB Printer in Admin Menu)");
      }
    }
    const chunkSize = 4096;
    for (let i = 0; i < escPosBytes.length; i += chunkSize) {
      const slice = escPosBytes.subarray(i, i + chunkSize);
      await state.usbDevice.transferOut(state.usbEndpointOut, slice);
    }
    log(`Sent ${escPosBytes.length} bytes via WebUSB (direct, watermark-free)`);
    return { transport: "web-usb", detail: "Printed directly via USB" };
  }

  /**
   * Transport 1: RawBT Local WebSocket Server (ws://localhost:40213/)
   */
  function sendViaRawbtWebSocket(escPosBytes) {
    const cfg = getConfig();
    const url = cfg.rawbtWsUrl || "ws://localhost:40213/";
    const timeoutMs = cfg.rawbtWsTimeoutMs || 2500;

    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { if (ws) ws.close(); } catch (_) {}
          reject(new Error(`RawBT WebSocket timeout (${url})`));
        }
      }, timeoutMs);

      try {
        ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }

      ws.onopen = () => {
        try {
          ws.send(escPosBytes.buffer);
          log(`Sent ${escPosBytes.length} bytes via RawBT WebSocket`);
          setTimeout(() => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              try { ws.close(); } catch (_) {}
              resolve({ transport: "rawbt-ws", detail: "Printed via RawBT WebSocket" });
            }
          }, 350);
        } catch (err) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        }
      };

      ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("RawBT WebSocket bridge unreachable (is RawBT running?)"));
        }
      };
    });
  }

  /**
   * Probe RawBT WebSocket availability without printing
   */
  function probeRawbtWebSocket() {
    const cfg = getConfig();
    const url = cfg.rawbtWsUrl || "ws://localhost:40213/";
    return new Promise((resolve) => {
      let settled = false;
      let ws;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { if (ws) ws.close(); } catch (_) {}
          resolve(false);
        }
      }, 1200);
      try {
        ws = new WebSocket(url);
        ws.onopen = () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            ws.close();
            resolve(true);
          }
        };
        ws.onerror = () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(false);
          }
        };
      } catch (_) {
        clearTimeout(timer);
        resolve(false);
      }
    });
  }

  /**
   * Transport 2: RawBT Android Intent URI (rawbt:base64,...)
   */
  function sendViaRawbtIntent(escPosBytes) {
    const isAndroid = /Android/i.test(navigator.userAgent || "");
    if (!isAndroid) {
      return Promise.reject(new Error("RawBT Intent URI only supported on Android devices"));
    }
    const b64 = uint8ToBase64(escPosBytes);
    const uri = `rawbt:base64,${b64}`;
    // Use hidden iframe or location assign to avoid leaving kiosk page
    const link = document.createElement("a");
    link.href = uri;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    log(`Dispatched ${escPosBytes.length} bytes via RawBT Android Intent`);
    return Promise.resolve({ transport: "rawbt-intent", detail: "Dispatched to RawBT app" });
  }

  /**
   * Transport 3: Web Bluetooth (GATT)
   */
  async function pairBluetooth() {
    if (!navigator.bluetooth) {
      throw new Error("Web Bluetooth is not supported in this browser");
    }
    const cfg = getConfig();
    const serviceUuids = cfg.bluetoothServiceUuids || ["000018f0-0000-1000-8000-00805f9b34fb"];
    const charUuids = cfg.bluetoothCharUuids || ["00002af1-0000-1000-8000-00805f9b34fb"];

    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: serviceUuids
    });

    device.addEventListener("gattserverdisconnected", () => {
      log(`Bluetooth printer disconnected: ${device.name || "Unknown"}`);
      state.bleCharacteristic = null;
      state.lastStatus = "Bluetooth Disconnected";
    });

    const server = await device.gatt.connect();
    let writableChar = null;

    for (const svcUuid of serviceUuids) {
      try {
        const svc = await server.getPrimaryService(svcUuid);
        for (const chUuid of charUuids) {
          try {
            const ch = await svc.getCharacteristic(chUuid);
            if (ch.properties.write || ch.properties.writeWithoutResponse) {
              writableChar = ch;
              break;
            }
          } catch (_) {}
        }
        if (!writableChar) {
          const chars = await svc.getCharacteristics();
          writableChar = chars.find((c) => c.properties.write || c.properties.writeWithoutResponse) || null;
        }
        if (writableChar) break;
      } catch (_) {}
    }

    if (!writableChar) {
      throw new Error("No writable ESC/POS GATT characteristic found on Bluetooth device");
    }

    state.bleDevice = device;
    state.bleCharacteristic = writableChar;
    state.lastStatus = `Bluetooth Connected (${device.name || "Printer"})`;
    log(state.lastStatus);
    return device.name || "BLE Printer";
  }

  async function sendViaWebBluetooth(escPosBytes) {
    if (!state.bleCharacteristic || !state.bleDevice || !state.bleDevice.gatt.connected) {
      throw new Error("Bluetooth printer is not connected (pair it in Admin Menu)");
    }
    const ch = state.bleCharacteristic;
    const mtuChunk = 100;
    for (let i = 0; i < escPosBytes.length; i += mtuChunk) {
      const slice = escPosBytes.subarray(i, i + mtuChunk);
      if (ch.properties.writeWithoutResponse) {
        await ch.writeValueWithoutResponse(slice);
      } else {
        await ch.writeValue(slice);
      }
      await new Promise((r) => setTimeout(r, 12));
    }
    log(`Sent ${escPosBytes.length} bytes via Web Bluetooth`);
    return { transport: "web-bluetooth", detail: "Printed via Bluetooth" };
  }

  /**
   * Transport 4: Backend ESC/POS Network/USB Relay
   */
  async function sendViaBackendRelay(escPosBytes) {
    const cfg = getConfig();
    const endpoint = cfg.backendRelayEndpoint || "/api/print";
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ escposBase64: uint8ToBase64(escPosBytes) })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) {
      throw new Error(data.error || `Backend printer relay error (HTTP ${resp.status})`);
    }
    log("Printed via Backend Relay");
    return { transport: "backend-relay", detail: data.message || "Printed via Backend Relay" };
  }

  /**
   * Print a dithered 576px Canvas via configured mode or automatic fallback chain.
   */
  async function printCanvas(canvas) {
    const cfg = getConfig();
    if (state.simulateError) {
      state.lastStatus = "Simulated Error (Offline / Out of Paper)";
      log("Blocked print: Simulated printer error active");
      throw new Error("Printer offline or out of paper (simulated)");
    }

    const escPosBytes = canvasToEscPos(canvas);
    const mode = cfg.mode || "auto";

    if (mode === "simulator") {
      await new Promise((r) => setTimeout(r, 1500));
      state.lastStatus = "Simulator OK";
      log(`Simulated thermal print (${escPosBytes.length} bytes ESC/POS generated)`);
      return { transport: "simulator", detail: "Simulated print complete", bytes: escPosBytes.length };
    }

    if (mode === "web-usb") {
      return await sendViaWebUsb(escPosBytes);
    }
    if (mode === "rawbt-ws") {
      return await sendViaRawbtWebSocket(escPosBytes);
    }
    if (mode === "rawbt-intent") {
      return await sendViaRawbtIntent(escPosBytes);
    }
    if (mode === "web-bluetooth") {
      return await sendViaWebBluetooth(escPosBytes);
    }
    if (mode === "backend-relay") {
      return await sendViaBackendRelay(escPosBytes);
    }

    // Auto mode prioritizes 100% free, watermark-free transports first:
    // WebUSB -> Backend Port-9100 Relay -> Web Bluetooth -> RawBT WS -> RawBT Intent
    const errors = [];
    if (state.usbDevice && state.usbDevice.opened) {
      try {
        const res = await sendViaWebUsb(escPosBytes);
        state.lastStatus = "WebUSB OK (Free)";
        return res;
      } catch (e) {
        errors.push(e.message);
      }
    }

    try {
      const res = await sendViaBackendRelay(escPosBytes);
      state.lastStatus = "Backend Relay OK (Free)";
      return res;
    } catch (e) {
      errors.push(e.message);
    }

    if (state.bleCharacteristic && state.bleDevice && state.bleDevice.gatt.connected) {
      try {
        const res = await sendViaWebBluetooth(escPosBytes);
        state.lastStatus = "Bluetooth OK (Free)";
        return res;
      } catch (e) {
        errors.push(e.message);
      }
    }

    try {
      const res = await sendViaRawbtWebSocket(escPosBytes);
      state.lastStatus = "RawBT WebSocket OK";
      return res;
    } catch (e) {
      errors.push(e.message);
    }

    if (cfg.rawbtIntentFallback && /Android/i.test(navigator.userAgent || "")) {
      const res = await sendViaRawbtIntent(escPosBytes);
      state.lastStatus = "RawBT Intent Dispatched";
      return res;
    }

    state.lastStatus = "Disconnected";
    throw new Error(errors.join(" · "));
  }

  /**
   * Probes available printer transports and returns human-readable status.
   */
  async function checkStatus() {
    const cfg = getConfig();
    if (state.simulateError) {
      state.lastStatus = "Simulated Error (Offline / Paper Out)";
      return { connected: false, status: state.lastStatus };
    }
    if (cfg.mode === "simulator") {
      state.lastStatus = "Simulator Ready (Mac Testing)";
      return { connected: true, status: state.lastStatus };
    }
    if (state.usbDevice && state.usbDevice.opened) {
      state.lastStatus = `USB Connected (${state.usbDevice.productName || "Printer"})`;
      return { connected: true, status: state.lastStatus };
    }
    if (state.bleDevice && state.bleDevice.gatt && state.bleDevice.gatt.connected) {
      state.lastStatus = `Bluetooth Connected (${state.bleDevice.name || "Printer"})`;
      return { connected: true, status: state.lastStatus };
    }
    try {
      const r = await fetch("/api/health");
      if (r.ok) {
        const h = await r.json();
        if (h.printerRelayConfigured) {
          state.lastStatus = "Backend Network Printer Ready (Free)";
          return { connected: true, status: state.lastStatus };
        }
      }
    } catch (_) {}
    const wsOk = await probeRawbtWebSocket();
    if (wsOk) {
      state.lastStatus = "RawBT WebSocket Connected";
      return { connected: true, status: state.lastStatus };
    }

    if (/Android/i.test(navigator.userAgent || "") && cfg.rawbtIntentFallback) {
      state.lastStatus = "Android RawBT Intent Ready (WS off)";
      return { connected: true, status: state.lastStatus };
    }

    state.lastStatus = "Not Detected (Offline / Unpaired)";
    return { connected: false, status: state.lastStatus };
  }

  /**
   * Generates and prints a compact 80mm Epson TM-T20III diagnostic slip.
   */
  async function printTestSlip() {
    const cfg = getConfig();
    const width = cfg.paperWidthPx || 576;
    const c = document.createElement("canvas");
    c.width = width;
    c.height = 360;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, width, 360);

    if (global.BSFCAssets) {
      global.BSFCAssets.drawBsfcLogo(ctx, 20, 16, 150, true);
    }

    ctx.fillStyle = "#000000";
    ctx.font = "900 24px 'Arial Black', sans-serif";
    ctx.fillText("BSFC TEST PRINT", 190, 55);
    ctx.font = "700 18px monospace";
    ctx.fillText("Printer: Epson TM-T20III (80mm)", 190, 88);
    ctx.fillText(`Time: ${new Date().toLocaleString()}`, 190, 114);
    ctx.fillText(`Dither: ${cfg.ditherMethod || "atkinson"}`, 190, 140);

    // Dither calibration bar
    const bar = ctx.createLinearGradient(24, 0, width - 24, 0);
    bar.addColorStop(0, "#000000");
    bar.addColorStop(1, "#FFFFFF");
    ctx.fillStyle = bar;
    ctx.fillRect(24, 180, width - 48, 60);
    if (global.BSFCAssets) {
      const barData = ctx.getImageData(24, 180, width - 48, 60);
      global.BSFCAssets.applyDithering(barData, cfg.ditherMethod || "atkinson");
      ctx.putImageData(barData, 24, 180);
    }

    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 3;
    ctx.strokeRect(24, 180, width - 48, 60);
    ctx.font = "900 22px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("2440 Bancroft Way #102 — PRINTER OK!", width / 2, 290);

    return await printCanvas(c);
  }

  global.BSFCPrinter = {
    canvasToEscPos,
    printCanvas,
    printTestSlip,
    pairUsb,
    reconnectUsb,
    pairBluetooth,
    checkStatus,
    setSimulateError(val) {
      state.simulateError = Boolean(val);
      log(`Simulated printer error: ${state.simulateError}`);
    },
    getSimulateError() {
      return state.simulateError;
    },
    getLogs() {
      return state.logs.slice().reverse().join("\n");
    }
  };
})(window);
