/**
 * BSFC Web Photobooth — Core Kiosk Application State Machine
 * ---------------------------------------------------------------------------
 * Handles:
 *   - Screen transitions (Attract -> Consent -> Capture -> Review/Retake -> Print)
 *   - 60-second inactivity watchdog & complete session data wipe
 *   - 2-minute persistent print cooldown (1 physical print per session)
 *   - Live camera preview with non-blocking BSFC overlay & randomized pose prompts
 *   - 3-second countdown, shutter flash, Web Audio chimes
 *   - QR & SMS digital delivery with printer-error graceful fallback
 *   - Discreet hidden Admin Menu protected by 4-digit PIN
 */
(function () {
  "use strict";

  const CFG = window.BSFC_CONFIG;
  const EFFECTS = ["normal", "bw", "warm"];
  const EFFECT_LABELS = { normal: "Color", bw: "Thermal B&W", warm: "Co-op Warm" };

  const STORAGE_KEYS = {
    LAST_PRINT_TS: "bsfc_last_print_ts",
    SLEEP_MODE: "bsfc_sleep_mode",
    PRINTER_MODE: "bsfc_printer_mode",
    DITHER_METHOD: "bsfc_dither_method"
  };

  // Kiosk application state
  const state = {
    screen: "attract",
    sleepMode: false,
    stream: null,
    cameraReady: false,
    effectIdx: 0,
    currentPromptIdx: -1,
    isCountingDown: false,
    isPrinting: false,
    shots: [],          // Array of HTMLCanvasElement (max 2: initial + 1 retake)
    selectedShotIdx: 0,
    retakeUsed: false,
    hasPrintedThisSession: false,
    previewMode: "thermal", // "thermal" | "digital"
    digitalStripCanvas: null,
    thermalStripCanvas: null,
    shareUrl: CFG.sharing.fallbackQrUrl,
    photoId: null,
    idleSeconds: 0,
    pinBuffer: "",
    adminTapCount: 0,
    adminTapTimer: null,
    adminHoldTimer: null,
    audioCtx: null
  };

  // DOM helpers
  const $ = (id) => document.getElementById(id);

  const els = {
    viewport: $("booth-viewport"),
    screens: {
      attract: $("screen-attract"),
      consent: $("screen-consent"),
      capture: $("screen-capture"),
      review: $("screen-review"),
      print: $("screen-print")
    },
    topbarStatus: $("topbar-status"),
    attractCooldownPill: $("attract-cooldown-pill"),
    dockSegs: {
      grid: $("dock-mode-grid"),
      single: $("dock-mode-single"),
      strip: $("dock-mode-strip")
    },
    dockShutter: $("dock-shutter-btn"),
    dockEffects: $("dock-effects-btn"),
    video: $("camera-video"),
    cameraFallback: $("camera-fallback"),
    cameraErrorMsg: $("camera-error-msg"),
    countdownOverlay: $("countdown-overlay"),
    countdownNumber: $("countdown-number"),
    flashOverlay: $("flash-overlay"),
    effectBadge: $("effect-badge"),
    promptText: $("capture-prompt-text"),
    takePhotoLabel: $("take-photo-label"),
    shotCard1: $("shot-card-1"),
    shotCard2: $("shot-card-2"),
    canvasShot1: $("canvas-shot-1"),
    canvasShot2: $("canvas-shot-2"),
    canvasFinalPreview: $("canvas-final-preview"),
    tabBtnRetake: $("tab-btn-retake"),
    tabBtnReady: $("tab-btn-ready"),
    panelShots: $("review-panel-shots"),
    panelReady: $("review-panel-ready"),
    btnDoRetake: $("btn-do-retake"),
    btnConfirmPrint: $("btn-confirm-print"),
    btnDigitalOnly: $("btn-digital-only"),
    readyCooldownAlert: $("ready-cooldown-alert"),
    btnPreviewThermal: $("btn-preview-thermal"),
    btnPreviewDigital: $("btn-preview-digital"),
    printerLed: $("printer-led"),
    animatedReceipt: $("animated-receipt"),
    canvasMiniReceipt: $("canvas-mini-receipt"),
    printStatusHeading: $("print-status-heading"),
    printErrorBanner: $("print-error-banner"),
    canvasPopupQr: $("canvas-popup-qr"),
    directDownloadLink: $("direct-download-link"),
    smsPhoneInput: $("sms-phone-input"),
    smsFeedback: $("sms-feedback"),
    printSessionCooldown: $("print-session-cooldown"),
    inactivityToast: $("inactivity-toast"),
    sleepOverlay: $("sleep-overlay")
  };

  /* ========================================================================
     Web Audio Synthesizer (Countdown Beeps & Retro Camera Shutter)
     ======================================================================== */
  function getAudioCtx() {
    if (!CFG.soundEnabled) return null;
    if (!state.audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) state.audioCtx = new AC();
    }
    if (state.audioCtx && state.audioCtx.state === "suspended") {
      state.audioCtx.resume().catch(() => {});
    }
    return state.audioCtx;
  }

  function playTone(freq, duration = 0.09, type = "sine", gainVal = 0.08) {
    const ctx = getAudioCtx();
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      gain.gain.setValueAtTime(gainVal, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duration);
    } catch (_) {}
  }

  function playShutterSound() {
    playTone(980, 0.05, "triangle", 0.12);
    setTimeout(() => playTone(620, 0.08, "triangle", 0.1), 55);
  }

  /* ========================================================================
     Cooldown & Persistent Settings Helpers
     ======================================================================== */
  function getCooldownRemainingSec() {
    const raw = localStorage.getItem(STORAGE_KEYS.LAST_PRINT_TS);
    if (!raw) return 0;
    const lastTs = parseInt(raw, 10);
    if (isNaN(lastTs)) return 0;
    const elapsed = Math.floor((Date.now() - lastTs) / 1000);
    return Math.max(0, CFG.printCooldownSec - elapsed);
  }

  function startPrintCooldown() {
    localStorage.setItem(STORAGE_KEYS.LAST_PRINT_TS, String(Date.now()));
    refreshCooldownUI();
  }

  function resetPrintCooldown() {
    localStorage.removeItem(STORAGE_KEYS.LAST_PRINT_TS);
    refreshCooldownUI();
  }

  function formatMMSS(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function refreshCooldownUI() {
    const rem = getCooldownRemainingSec();
    const adminStatus = $("admin-cooldown-status");
    if (adminStatus) {
      adminStatus.textContent = rem > 0 ? `Cooling down (${formatMMSS(rem)})` : "Ready";
    }

    if (rem > 0) {
      els.attractCooldownPill.textContent = `Next free print in ${formatMMSS(rem)} · Digital QR always ready`;
      els.attractCooldownPill.classList.remove("hidden");
      els.topbarStatus.textContent = `Print Cooldown ${formatMMSS(rem)}`;
      els.topbarStatus.classList.add("visible");
    } else {
      els.attractCooldownPill.classList.add("hidden");
      els.topbarStatus.classList.remove("visible");
    }

    // Ready-to-Print button gating (1 print per session + 2 min global cooldown)
    if (state.screen === "review") {
      if (state.hasPrintedThisSession || rem > 0) {
        const msg = state.hasPrintedThisSession
          ? "1 physical print per session limit reached — you can still grab your digital copy!"
          : `Printer cooldown active (${formatMMSS(rem)} remaining). Grab your free digital copy now or wait to print!`;
        els.readyCooldownAlert.textContent = msg;
        els.readyCooldownAlert.classList.remove("hidden");
        els.btnConfirmPrint.classList.add("hidden");
        els.btnDigitalOnly.classList.remove("hidden");
      } else {
        els.readyCooldownAlert.classList.add("hidden");
        els.btnConfirmPrint.classList.remove("hidden");
        els.btnDigitalOnly.classList.add("hidden");
      }
    }

    if (state.screen === "print") {
      els.printSessionCooldown.textContent =
        rem > 0
          ? `1 print/session · Next physical print in ${formatMMSS(rem)}`
          : "Print ready for next guest";
    }
  }

  /* ========================================================================
     Screen Navigation & Dock Synchronization
     ======================================================================== */
  function showScreen(name) {
    state.screen = name;
    Object.entries(els.screens).forEach(([key, el]) => {
      el.classList.toggle("active", key === name);
    });

    els.viewport.classList.toggle("hide-attract-doodle", name !== "attract");

    // Update dock segmented indicator
    els.dockSegs.grid.classList.toggle("active", name === "attract" || name === "consent");
    els.dockSegs.single.classList.toggle("active", name === "capture" || name === "review");
    els.dockSegs.strip.classList.toggle("active", name === "print");

    // Effects button highlighted when on capture screen
    els.dockEffects.classList.toggle("active-effect", name === "capture" && state.effectIdx !== 0);

    refreshCooldownUI();
  }

  /* ========================================================================
     Session Reset & 60-Second Inactivity Watchdog
     ======================================================================== */
  function resetIdleTimer() {
    state.idleSeconds = 0;
    els.inactivityToast.classList.add("hidden");
  }

  function stopCamera() {
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }
    if (els.video) {
      els.video.srcObject = null;
    }
    state.cameraReady = false;
  }

  function resetSession() {
    stopCamera();
    state.isCountingDown = false;
    state.isPrinting = false;
    state.shots = [];
    state.selectedShotIdx = 0;
    state.retakeUsed = false;
    state.hasPrintedThisSession = false;
    state.digitalStripCanvas = null;
    state.thermalStripCanvas = null;
    state.photoId = null;
    state.shareUrl = CFG.sharing.fallbackQrUrl;
    state.effectIdx = 0;
    applyVideoEffect();

    // Clear sensitive/session DOM fields
    els.smsPhoneInput.value = "";
    els.smsFeedback.textContent = "";
    els.smsFeedback.classList.remove("error");
    els.printErrorBanner.classList.add("hidden");
    els.animatedReceipt.classList.remove("feeding");
    els.countdownOverlay.classList.add("hidden");
    [els.canvasShot1, els.canvasShot2, els.canvasFinalPreview, els.canvasMiniReceipt].forEach((c) => {
      const ctx = c.getContext("2d");
      ctx.clearRect(0, 0, c.width, c.height);
    });
    closeAllModals();
    resetIdleTimer();
    showScreen("attract");
  }

  function startWatchdogs() {
    ["pointerdown", "keydown", "input", "change"].forEach((evt) => {
      document.addEventListener(evt, resetIdleTimer, { passive: true });
    });

    setInterval(() => {
      refreshCooldownUI();

      // Pause inactivity timeout on Attract screen, Sleep mode, or active countdown/print
      if (
        state.screen === "attract" ||
        state.sleepMode ||
        state.isCountingDown ||
        state.isPrinting ||
        !$("modal-admin-panel").classList.contains("hidden")
      ) {
        return;
      }

      state.idleSeconds++;
      const remaining = CFG.inactivityTimeoutSec - state.idleSeconds;
      if (remaining <= 15 && remaining > 0) {
        els.inactivityToast.textContent = `Still there? Resetting in ${remaining}s...`;
        els.inactivityToast.classList.remove("hidden");
      } else if (remaining <= 0) {
        resetSession();
      }
    }, 1000);
  }

  /* ========================================================================
     Camera, Effects & Prompts
     ======================================================================== */
  function pickRandomPrompt() {
    const prompts = CFG.prompts || ["Say cheese!"];
    let next = Math.floor(Math.random() * prompts.length);
    if (prompts.length > 1 && next === state.currentPromptIdx) {
      next = (next + 1) % prompts.length;
    }
    state.currentPromptIdx = next;
    els.promptText.textContent = prompts[next];
  }

  function applyVideoEffect() {
    const mode = EFFECTS[state.effectIdx];
    els.video.classList.remove("effect-bw", "effect-warm");
    if (mode === "bw") els.video.classList.add("effect-bw");
    if (mode === "warm") els.video.classList.add("effect-warm");
    els.effectBadge.textContent = EFFECT_LABELS[mode];
    els.dockEffects.classList.toggle("active-effect", state.screen === "capture" && mode !== "normal");
  }

  function cycleEffect() {
    state.effectIdx = (state.effectIdx + 1) % EFFECTS.length;
    applyVideoEffect();
    playTone(540, 0.06, "sine", 0.05);
  }

  async function startCamera() {
    els.cameraFallback.classList.add("hidden");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      els.cameraErrorMsg.textContent =
        "Camera API unavailable (requires HTTPS or localhost). You can still test with a Demo Snapshot!";
      els.cameraFallback.classList.remove("hidden");
      return;
    }
    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 1280 }
        },
        audio: false
      });
      state.stream = stream;
      els.video.srcObject = stream;
      await els.video.play();
      state.cameraReady = true;
    } catch (err) {
      state.cameraReady = false;
      els.cameraErrorMsg.textContent =
        "Unable to access front camera (" + (err.message || "permission denied") + ").";
      els.cameraFallback.classList.remove("hidden");
    }
  }

  function captureVideoFrame() {
    const out = document.createElement("canvas");
    out.width = 1000;
    out.height = 965; // Matches printed layout.jpg inner photo aspect ratio
    const ctx = out.getContext("2d");

    if (state.cameraReady && els.video.videoWidth > 0) {
      const vw = els.video.videoWidth;
      const vh = els.video.videoHeight;
      const targetRatio = out.width / out.height;
      const srcRatio = vw / vh;
      let sx = 0, sy = 0, sw = vw, sh = vh;
      if (srcRatio > targetRatio) {
        sw = vh * targetRatio;
        sx = (vw - sw) / 2;
      } else {
        sh = vw / targetRatio;
        sy = (vh - sh) / 2;
      }

      ctx.save();
      // Apply active live effect to digital capture
      const mode = EFFECTS[state.effectIdx];
      if (mode === "bw") ctx.filter = "grayscale(100%) contrast(1.25) brightness(1.06)";
      if (mode === "warm") ctx.filter = "sepia(0.28) saturate(1.22) contrast(1.06)";

      // Mirror horizontally to match front-facing selfie preview
      ctx.translate(out.width, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(els.video, sx, sy, sw, sh, 0, 0, out.width, out.height);
      ctx.restore();
    } else {
      drawDemoPortrait(ctx, out.width, out.height);
    }
    return out;
  }

  function drawDemoPortrait(ctx, w, h) {
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, "#FFE5D4");
    grad.addColorStop(1, "#D8F3DC");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Friendly illustrated avocado character for camera-less Mac testing
    ctx.fillStyle = "#52B788";
    ctx.beginPath();
    ctx.ellipse(w / 2, h * 0.56, 175, 220, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#B7E4C7";
    ctx.beginPath();
    ctx.ellipse(w / 2, h * 0.58, 138, 175, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#7F4F24";
    ctx.beginPath();
    ctx.arc(w / 2, h * 0.65, 68, 0, Math.PI * 2);
    ctx.fill();
    // Eyes & smile
    ctx.fillStyle = "#1E1B18";
    ctx.beginPath();
    ctx.arc(w * 0.44, h * 0.46, 14, 0, Math.PI * 2);
    ctx.arc(w * 0.56, h * 0.46, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 10;
    ctx.strokeStyle = "#1E1B18";
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(w / 2, h * 0.49, 44, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();

    ctx.fillStyle = "#2D6A4F";
    ctx.font = "900 38px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("BSFC DEMO SNAPSHOT", w / 2, h * 0.89);
  }

  function triggerShutterFlash() {
    els.flashOverlay.classList.remove("hidden", "active");
    void els.flashOverlay.offsetWidth; // Force reflow
    els.flashOverlay.classList.add("active");
    setTimeout(() => {
      els.flashOverlay.classList.add("hidden");
      els.flashOverlay.classList.remove("active");
    }, 480);
  }

  function startCountdownAndCapture() {
    if (state.isCountingDown) return;
    state.isCountingDown = true;
    let count = CFG.countdownSec || 3;
    els.countdownNumber.textContent = String(count);
    els.countdownOverlay.classList.remove("hidden");
    playTone(660, 0.1, "sine", 0.08);

    const timer = setInterval(() => {
      count--;
      if (count > 0) {
        els.countdownNumber.textContent = String(count);
        playTone(660, 0.1, "sine", 0.08);
      } else {
        clearInterval(timer);
        els.countdownOverlay.classList.add("hidden");
        triggerShutterFlash();
        playShutterSound();
        const frame = captureVideoFrame();
        state.isCountingDown = false;
        handleCapturedFrame(frame);
      }
    }, 1000);
  }

  function handleCapturedFrame(frameCanvas) {
    if (state.shots.length === 0) {
      state.shots.push(frameCanvas);
      state.selectedShotIdx = 0;
    } else {
      // Retake shot (index 1)
      state.shots[1] = frameCanvas;
      state.selectedShotIdx = 1;
      state.retakeUsed = true;
    }
    stopCamera();
    renderReviewScreen("shots");
    showScreen("review");
  }

  /* ========================================================================
     Review & Retake Tabbed Flow
     ======================================================================== */
  function renderShotToCanvas(src, dest) {
    dest.width = src.width;
    dest.height = src.height;
    dest.getContext("2d").drawImage(src, 0, 0);
  }

  function renderReviewScreen(activeTab) {
    // Update tabs UI
    document.querySelectorAll(".review-tab").forEach((btn) => {
      const t = btn.dataset.tab;
      btn.classList.toggle("active", t === activeTab);
      btn.setAttribute("aria-selected", String(t === activeTab));
    });

    els.tabBtnRetake.textContent = state.retakeUsed ? "2. Retake (Used)" : "2. Retake (1 left)";
    els.tabBtnRetake.disabled = state.retakeUsed && state.shots.length < 2;

    if (activeTab === "ready") {
      els.panelShots.classList.add("hidden");
      els.panelReady.classList.remove("hidden");
      renderFinalComposites();
    } else {
      els.panelShots.classList.remove("hidden");
      els.panelReady.classList.add("hidden");

      if (state.shots[0]) renderShotToCanvas(state.shots[0], els.canvasShot1);
      if (state.shots[1]) {
        els.shotCard2.classList.remove("hidden");
        renderShotToCanvas(state.shots[1], els.canvasShot2);
      } else {
        els.shotCard2.classList.add("hidden");
      }

      els.shotCard1.classList.toggle("selected", state.selectedShotIdx === 0);
      els.shotCard2.classList.toggle("selected", state.selectedShotIdx === 1);

      els.btnDoRetake.disabled = state.retakeUsed;
      els.btnDoRetake.textContent = state.retakeUsed ? "Retake Used (0 Left)" : "🔄 Retake (1 Left)";
    }
  }

  function renderFinalComposites() {
    const chosen = state.shots[state.selectedShotIdx] || state.shots[0];
    if (!chosen) return;

    const pCfg = CFG.printer || {};
    state.digitalStripCanvas = window.BSFCAssets.composeStripCanvas({
      photoCanvas: chosen,
      qrText: state.shareUrl,
      thermal: false,
      width: 1080
    });

    state.thermalStripCanvas = window.BSFCAssets.composeStripCanvas({
      photoCanvas: chosen,
      qrText: state.shareUrl,
      thermal: true,
      width: pCfg.paperWidthPx || 576,
      ditherMethod: pCfg.ditherMethod || "atkinson",
      ditherOpts: {
        contrast: pCfg.contrast,
        brightness: pCfg.brightness,
        gamma: pCfg.gamma
      }
    });

    updateFinalPreviewCanvas();
  }

  function updateFinalPreviewCanvas() {
    const src = state.previewMode === "thermal" ? state.thermalStripCanvas : state.digitalStripCanvas;
    if (!src) return;
    els.canvasFinalPreview.width = src.width;
    els.canvasFinalPreview.height = src.height;
    els.canvasFinalPreview.getContext("2d").drawImage(src, 0, 0);

    els.btnPreviewThermal.classList.toggle("active", state.previewMode === "thermal");
    els.btnPreviewDigital.classList.toggle("active", state.previewMode === "digital");
  }

  function enterCaptureForRetake() {
    if (state.retakeUsed) return;
    els.takePhotoLabel.textContent = "Take Retake Photo";
    pickRandomPrompt();
    showScreen("capture");
    startCamera();
  }

  /* ========================================================================
     Printing, Upload, QR Code & SMS Delivery
     ======================================================================== */
  async function uploadDigitalStrip(digitalCanvas) {
    const dataUrl = digitalCanvas.toDataURL("image/png");
    els.directDownloadLink.href = dataUrl;

    try {
      const resp = await fetch(CFG.sharing.photoUploadEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: dataUrl })
      });
      if (!resp.ok) throw new Error("Upload HTTP " + resp.status);
      const data = await resp.json();
      const base = CFG.sharing.publicBaseUrl || window.location.origin;
      state.photoId = data.id;
      state.shareUrl = data.shareUrl.startsWith("http") ? data.shareUrl : `${base}${data.shareUrl}`;
      els.directDownloadLink.href = data.downloadUrl || dataUrl;
    } catch (_) {
      // Offline / static-file fallback: QR points to BSFC social page, PNG link remains downloadable
      state.shareUrl = CFG.sharing.fallbackQrUrl;
    }
  }

  async function executePrintAndShare(skipPhysicalPrint = false) {
    if (state.isPrinting) return;
    state.isPrinting = true;

    const chosen = state.shots[state.selectedShotIdx] || state.shots[0];
    if (!chosen) {
      state.isPrinting = false;
      return;
    }

    // 1. Compose initial digital strip & upload so QR encodes real hosted share URL
    const preDigital = window.BSFCAssets.composeStripCanvas({
      photoCanvas: chosen,
      qrText: CFG.sharing.fallbackQrUrl,
      thermal: false,
      width: 1080
    });

    showScreen("print");
    els.printerLed.classList.remove("error", "done");
    els.printErrorBanner.classList.add("hidden");
    els.animatedReceipt.classList.remove("feeding");
    els.printStatusHeading.textContent = skipPhysicalPrint
      ? "Preparing your digital BSFC strip..."
      : "Printing your BSFC strip...";

    await uploadDigitalStrip(preDigital);

    // 2. Re-compose both digital & thermal strips with the live QR URL
    renderFinalComposites();

    // Re-upload final digital strip with embedded live QR URL if hosted
    if (state.photoId) {
      try {
        const finalDataUrl = state.digitalStripCanvas.toDataURL("image/png");
        els.directDownloadLink.href = finalDataUrl;
        await fetch(`${CFG.sharing.photoUploadEndpoint}/${state.photoId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageBase64: finalDataUrl })
        });
      } catch (_) {}
    }

    // 3. Render pop-up QR code & mini animated receipt preview
    window.BSFCQRCode.drawToCanvas(els.canvasPopupQr, state.shareUrl, {
      size: 176,
      quietZone: 2
    });
    renderShotToCanvas(state.thermalStripCanvas, els.canvasMiniReceipt);
    setTimeout(() => els.animatedReceipt.classList.add("feeding"), 120);

    // 4. Send to thermal printer unless skipped due to active cooldown
    if (skipPhysicalPrint) {
      els.printerLed.classList.add("done");
      els.printStatusHeading.textContent = "Digital strip ready! (Cooldown active)";
      state.isPrinting = false;
      return;
    }

    // Enforce 1 physical print per session & start 2-minute cooldown immediately
    state.hasPrintedThisSession = true;
    startPrintCooldown();

    try {
      await window.BSFCPrinter.printCanvas(state.thermalStripCanvas);
      els.printerLed.classList.add("done");
      els.printStatusHeading.textContent = "Printed! Grab your strip below ↓";
    } catch (err) {
      els.printerLed.classList.add("error");
      els.printStatusHeading.textContent = "Printer needs attention — digital copy ready!";
      els.printErrorBanner.textContent =
        "Oops! Our thermal printer appears disconnected, offline, or out of paper (" +
        err.message +
        "). Don't worry — scan the QR code or text yourself your full-color photo right here!";
      els.printErrorBanner.classList.remove("hidden");
    } finally {
      state.isPrinting = false;
    }
  }

  async function handleSendSms() {
    const raw = (els.smsPhoneInput.value || "").trim();
    const isEmail = raw.includes("@");
    const digits = raw.replace(/\D/g, "");
    if (!isEmail && digits.length < 10) {
      els.smsFeedback.textContent = "Please enter a 10-digit mobile number or email address.";
      els.smsFeedback.classList.add("error");
      return;
    }

    els.smsFeedback.classList.remove("error");
    els.smsFeedback.textContent = isEmail ? "Sending email..." : "Sending text message...";
    $("btn-send-sms").disabled = true;

    try {
      const resp = await fetch(CFG.sharing.smsEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: isEmail ? "" : raw,
          email: isEmail ? raw : "",
          photoId: state.photoId,
          shareUrl: state.shareUrl
        })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) {
        throw new Error(data.error || "Delivery service unavailable");
      }
      if (data.mode === "stub") {
        els.smsFeedback.textContent = "✓ Demo message logged! (Scan QR for instant download)";
      } else if (data.mode === "smtp") {
        els.smsFeedback.textContent = "✓ Photo strip emailed to you!";
      } else {
        els.smsFeedback.textContent = "✓ Photo strip texted to your phone!";
      }
    } catch (err) {
      els.smsFeedback.classList.add("error");
      els.smsFeedback.textContent = "Could not send (" + err.message + "). Please scan the QR code!";
    } finally {
      $("btn-send-sms").disabled = false;
    }
  }

  /* ========================================================================
     Modals, Sleep Mode & Discreet Admin Menu
     ======================================================================== */
  function closeAllModals() {
    document.querySelectorAll(".modal-backdrop").forEach((m) => m.classList.add("hidden"));
  }

  function openModal(id) {
    closeAllModals();
    $(id).classList.remove("hidden");
  }

  function applySleepMode(enabled) {
    state.sleepMode = Boolean(enabled);
    localStorage.setItem(STORAGE_KEYS.SLEEP_MODE, state.sleepMode ? "1" : "0");
    els.sleepOverlay.classList.toggle("hidden", !state.sleepMode);
    $("admin-toggle-sleep").textContent = state.sleepMode
      ? "Disable Sleep Mode (Wake Booth)"
      : "Enable Sleep Mode";
    if (state.sleepMode) {
      stopCamera();
    }
  }

  function openAdminPinPrompt() {
    state.pinBuffer = "";
    renderPinDots();
    $("pin-error").textContent = "";
    openModal("modal-admin-pin");
  }

  function renderPinDots() {
    const dots = $("pin-dots").querySelectorAll("span");
    dots.forEach((d, idx) => d.classList.toggle("filled", idx < state.pinBuffer.length));
  }

  function handlePinDigit(digit) {
    if (state.pinBuffer.length >= 4) return;
    state.pinBuffer += digit;
    renderPinDots();
    $("pin-error").textContent = "";

    if (state.pinBuffer.length === 4) {
      if (state.pinBuffer === String(CFG.adminPin)) {
        openAdminPanel();
      } else {
        $("pin-error").textContent = "Incorrect PIN — try again";
        playTone(220, 0.16, "sawtooth", 0.08);
        setTimeout(() => {
          state.pinBuffer = "";
          renderPinDots();
        }, 420);
      }
    }
  }

  async function openAdminPanel() {
    openModal("modal-admin-panel");
    $("admin-printer-mode").value = CFG.printer.mode || "auto";
    $("admin-dither-method").value = CFG.printer.ditherMethod || "atkinson";
    $("admin-toggle-sim-error").textContent = window.BSFCPrinter.getSimulateError() ? "ON (Simulating Error)" : "Off";
    $("admin-printer-log").textContent = window.BSFCPrinter.getLogs() || "No printer events yet.";
    refreshCooldownUI();
    await updateAdminPrinterStatus();
  }

  async function updateAdminPrinterStatus() {
    $("admin-printer-status").textContent = "Checking...";
    const res = await window.BSFCPrinter.checkStatus();
    $("admin-printer-status").textContent = res.status;
    $("admin-printer-log").textContent = window.BSFCPrinter.getLogs() || "Ready.";
  }

  function setupAdminTrigger(el) {
    if (!el) return;
    el.addEventListener("pointerdown", () => {
      state.adminHoldTimer = setTimeout(() => {
        openAdminPinPrompt();
      }, 1600);
    });
    const clearHold = () => {
      if (state.adminHoldTimer) {
        clearTimeout(state.adminHoldTimer);
        state.adminHoldTimer = null;
      }
    };
    el.addEventListener("pointerup", clearHold);
    el.addEventListener("pointercancel", clearHold);
    el.addEventListener("click", () => {
      state.adminTapCount++;
      clearTimeout(state.adminTapTimer);
      if (state.adminTapCount >= 5) {
        state.adminTapCount = 0;
        openAdminPinPrompt();
      } else {
        state.adminTapTimer = setTimeout(() => {
          state.adminTapCount = 0;
        }, 2500);
      }
    });
  }

  /* ========================================================================
     Event Wiring & Initialization
     ======================================================================== */
  function init() {
    // Restore persisted admin overrides
    const savedMode = localStorage.getItem(STORAGE_KEYS.PRINTER_MODE);
    if (savedMode) CFG.printer.mode = savedMode;
    const savedDither = localStorage.getItem(STORAGE_KEYS.DITHER_METHOD);
    if (savedDither) CFG.printer.ditherMethod = savedDither;

    // Inject BSFC vector SVG logos
    const svg = window.BSFCAssets.getBsfcLogoSvg();
    $("consent-logo-holder").innerHTML = svg;
    $("live-logo-overlay").innerHTML = svg;
    $("consent-notice-text").textContent = CFG.branding.consentNotice;

    // Sleep mode restore
    if (localStorage.getItem(STORAGE_KEYS.SLEEP_MODE) === "1") {
      applySleepMode(true);
    }

    // Attract Screen -> Consent
    const goConsent = () => {
      playTone(740, 0.07, "sine", 0.06);
      showScreen("consent");
    };
    $("btn-attract-start").addEventListener("click", goConsent);
    $("screen-attract").addEventListener("click", (e) => {
      if (e.target.closest("#btn-help") || e.target.closest("#admin-trigger") || e.target.closest("#btn-attract-start")) {
        return;
      }
      goConsent();
    });

    // Help Modal
    $("btn-help").addEventListener("click", (e) => {
      e.stopPropagation();
      openModal("modal-help");
    });

    document.querySelectorAll("[data-close-modal]").forEach((btn) => {
      btn.addEventListener("click", () => $(btn.dataset.closeModal).classList.add("hidden"));
    });

    // Consent Actions
    $("btn-consent-back").addEventListener("click", resetSession);
    $("btn-consent-agree").addEventListener("click", () => {
      els.takePhotoLabel.textContent = "Take Photo";
      pickRandomPrompt();
      showScreen("capture");
      startCamera();
    });

    // Capture Actions
    $("btn-shuffle-prompt").addEventListener("click", pickRandomPrompt);
    $("btn-take-photo").addEventListener("click", startCountdownAndCapture);
    $("btn-capture-cancel").addEventListener("click", resetSession);
    $("btn-retry-camera").addEventListener("click", startCamera);
    $("btn-demo-photo").addEventListener("click", () => {
      state.cameraReady = false;
      startCountdownAndCapture();
    });

    // Dock Controls
    els.dockEffects.addEventListener("click", () => {
      if (state.screen === "capture") cycleEffect();
    });
    els.dockShutter.addEventListener("click", () => {
      if (state.screen === "attract") goConsent();
      else if (state.screen === "consent") $("btn-consent-agree").click();
      else if (state.screen === "capture") startCountdownAndCapture();
    });

    // Review Tabs & Shot Selection
    document.querySelectorAll(".review-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        const target = tab.dataset.tab;
        if (target === "retake") {
          if (!state.retakeUsed) enterCaptureForRetake();
          else renderReviewScreen("shots");
        } else if (target === "shot1") {
          renderReviewScreen("shots");
        } else if (target === "ready") {
          renderReviewScreen("ready");
        }
      });
    });

    [els.shotCard1, els.shotCard2].forEach((card) => {
      card.addEventListener("click", () => {
        const idx = parseInt(card.dataset.shot, 10);
        if (state.shots[idx]) {
          state.selectedShotIdx = idx;
          renderReviewScreen("shots");
        }
      });
    });

    $("btn-do-retake").addEventListener("click", enterCaptureForRetake);
    $("btn-to-ready").addEventListener("click", () => renderReviewScreen("ready"));
    $("btn-back-to-shots").addEventListener("click", () => renderReviewScreen("shots"));

    els.btnPreviewThermal.addEventListener("click", () => {
      state.previewMode = "thermal";
      updateFinalPreviewCanvas();
    });
    els.btnPreviewDigital.addEventListener("click", () => {
      state.previewMode = "digital";
      updateFinalPreviewCanvas();
    });

    // Print & Digital Sharing
    els.btnConfirmPrint.addEventListener("click", () => executePrintAndShare(false));
    els.btnDigitalOnly.addEventListener("click", () => executePrintAndShare(true));
    $("btn-send-sms").addEventListener("click", handleSendSms);
    $("btn-done-reset").addEventListener("click", resetSession);

    // Hidden Admin Triggers & Keypad
    setupAdminTrigger($("admin-trigger"));
    setupAdminTrigger($("sleep-admin-trigger"));

    document.querySelectorAll(".pin-key[data-digit]").forEach((k) => {
      k.addEventListener("click", () => handlePinDigit(k.dataset.digit));
    });
    $("pin-clear").addEventListener("click", () => {
      state.pinBuffer = "";
      renderPinDots();
    });
    $("pin-back").addEventListener("click", () => {
      state.pinBuffer = state.pinBuffer.slice(0, -1);
      renderPinDots();
    });

    // Admin Panel Actions
    $("admin-toggle-sleep").addEventListener("click", () => {
      applySleepMode(!state.sleepMode);
      if (state.sleepMode) closeAllModals();
    });
    $("admin-reset-cooldown").addEventListener("click", () => {
      resetPrintCooldown();
      playTone(880, 0.08, "sine", 0.06);
    });
    $("admin-check-printer").addEventListener("click", updateAdminPrinterStatus);
    $("admin-printer-mode").addEventListener("change", (e) => {
      CFG.printer.mode = e.target.value;
      localStorage.setItem(STORAGE_KEYS.PRINTER_MODE, CFG.printer.mode);
      updateAdminPrinterStatus();
    });
    $("admin-dither-method").addEventListener("change", (e) => {
      CFG.printer.ditherMethod = e.target.value;
      localStorage.setItem(STORAGE_KEYS.DITHER_METHOD, CFG.printer.ditherMethod);
    });
    $("admin-toggle-sim-error").addEventListener("click", () => {
      const next = !window.BSFCPrinter.getSimulateError();
      window.BSFCPrinter.setSimulateError(next);
      $("admin-toggle-sim-error").textContent = next ? "ON (Simulating Error)" : "Off";
      updateAdminPrinterStatus();
    });
    $("admin-fullscreen").addEventListener("click", async () => {
      try {
        if (!document.fullscreenElement) {
          await document.documentElement.requestFullscreen();
        } else {
          await document.exitFullscreen();
        }
      } catch (_) {}
    });
    $("admin-pair-usb").addEventListener("click", async () => {
      try {
        const name = await window.BSFCPrinter.pairUsb();
        $("admin-printer-status").textContent = `USB Connected (${name})`;
      } catch (err) {
        $("admin-printer-status").textContent = `USB Error: ${err.message}`;
      }
      $("admin-printer-log").textContent = window.BSFCPrinter.getLogs();
    });
    $("admin-pair-ble").addEventListener("click", async () => {
      try {
        const name = await window.BSFCPrinter.pairBluetooth();
        $("admin-printer-status").textContent = `Bluetooth Connected (${name})`;
      } catch (err) {
        $("admin-printer-status").textContent = `BLE Error: ${err.message}`;
      }
      $("admin-printer-log").textContent = window.BSFCPrinter.getLogs();
    });
    $("admin-test-print").addEventListener("click", async () => {
      $("admin-printer-status").textContent = "Sending test print...";
      try {
        const res = await window.BSFCPrinter.printTestSlip();
        $("admin-printer-status").textContent = `Test Print OK (${res.transport})`;
      } catch (err) {
        $("admin-printer-status").textContent = `Test Print Failed: ${err.message}`;
      }
      $("admin-printer-log").textContent = window.BSFCPrinter.getLogs();
    });

    if (window.BSFCPrinter && window.BSFCPrinter.reconnectUsb) {
      window.BSFCPrinter.reconnectUsb().catch(() => {});
    }

    refreshCooldownUI();
    startWatchdogs();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
