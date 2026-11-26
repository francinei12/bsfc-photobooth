/**
 * BSFC Brand Vector Assets, Photostrip Compositor & Thermal Image Dithering
 * ---------------------------------------------------------------------------
 * Implements:
 * 1. Exact BSFC Lips Logo ("BERKELEY STUDENT FOOD COLLECTIVE") in SVG & Canvas
 * 2. Photostrip compositor matching `printed layout.jpg` (digital color & 80mm B&W)
 * 3. Atkinson & Floyd-Steinberg dithering optimized for 203 DPI thermal portraits
 */
(function (global) {
  "use strict";

  /**
   * Draws the tilted BSFC Lips Logo onto any 2D Canvas context.
   * Mirrors `printed layout.jpg`: red expressive lips, white upper teeth,
   * and bold stacked lime-green "BERKELEY / STUDENT FOOD / COLLECTIVE".
   */
  function drawBsfcLogo(ctx, x, y, width, monochrome = false) {
    const height = width * 0.84;
    const cx = x + width / 2;
    const cy = y + height / 2;

    const lipFill = monochrome ? "#111111" : "#E5301F";
    const lipHighlight = monochrome ? "#333333" : "#F35C4A";
    const lipShadow = monochrome ? "#000000" : "#B81D11";
    const mouthBg = "#FFFFFF";
    const textColor = monochrome ? "#000000" : "#6BBF2E";
    const teethLine = monochrome ? "#111111" : "#E5301F";

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-0.12); // Subtle tilted sticker badge matching printed layout.jpg
    const s = width / 220;
    ctx.scale(s, s);
    ctx.translate(-110, -92);

    // Subtle drop shadow for digital version
    if (!monochrome) {
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.22)";
      ctx.shadowBlur = 8;
      ctx.shadowOffsetX = 2;
      ctx.shadowOffsetY = 4;
      ctx.beginPath();
      traceOuterLipsPath(ctx);
      ctx.fillStyle = lipFill;
      ctx.fill();
      ctx.restore();
    }

    // Outer red lips silhouette
    ctx.beginPath();
    traceOuterLipsPath(ctx);
    ctx.fillStyle = lipFill;
    ctx.fill();

    // Subtle lip edge shading
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = lipShadow;
    ctx.stroke();

    // Specular highlight arc on upper/lower lip
    ctx.beginPath();
    ctx.moveTo(46, 36);
    ctx.quadraticCurveTo(75, 19, 98, 25);
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.strokeStyle = lipHighlight;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(64, 158);
    ctx.quadraticCurveTo(114, 173, 158, 152);
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = lipHighlight;
    ctx.stroke();

    // White inner mouth opening
    ctx.beginPath();
    traceInnerMouthPath(ctx);
    ctx.fillStyle = mouthBg;
    ctx.fill();

    // Upper teeth row clipped inside mouth opening
    ctx.save();
    ctx.beginPath();
    traceInnerMouthPath(ctx);
    ctx.clip();

    // Teeth separator lines
    ctx.strokeStyle = teethLine;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    // Bottom edge of teeth
    ctx.moveTo(30, 56);
    ctx.quadraticCurveTo(110, 34, 188, 57);
    ctx.stroke();

    const toothXs = [54, 72, 91, 110, 129, 148, 166];
    for (const tx of toothXs) {
      ctx.beginPath();
      ctx.moveTo(tx, 22);
      ctx.lineTo(tx, 52);
      ctx.stroke();
    }

    // Stacked green typography inside the mouth
    ctx.fillStyle = textColor;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Row 1: BERKELEY
    ctx.font = "900 18.5px 'Arial Black', 'Impact', 'Helvetica Neue', sans-serif";
    ctx.fillText("BERKELEY", 109, 68);

    // Row 2: STUDENT FOOD (tall, punchy)
    ctx.save();
    ctx.translate(109, 98);
    ctx.scale(0.88, 1.24);
    ctx.font = "900 26px 'Impact', 'Arial Black', sans-serif";
    ctx.fillText("STUDENT FOOD", 0, 0);
    ctx.restore();

    // Row 3: COLLECTIVE
    ctx.save();
    ctx.translate(109, 131);
    ctx.scale(0.95, 1.05);
    ctx.font = "900 20.5px 'Impact', 'Arial Black', sans-serif";
    ctx.fillText("COLLECTIVE", 0, 0);
    ctx.restore();

    ctx.restore(); // end mouth clip
    ctx.restore(); // end transform
  }

  function traceOuterLipsPath(ctx) {
    ctx.moveTo(12, 86);
    ctx.bezierCurveTo(32, 54, 62, 14, 92, 14);
    ctx.bezierCurveTo(103, 14, 108, 22, 112, 23);
    ctx.bezierCurveTo(118, 22, 125, 14, 138, 15);
    ctx.bezierCurveTo(168, 17, 195, 50, 210, 78);
    ctx.bezierCurveTo(205, 118, 176, 174, 114, 176);
    ctx.bezierCurveTo(56, 177, 25, 126, 12, 86);
    ctx.closePath();
  }

  function traceInnerMouthPath(ctx) {
    ctx.moveTo(34, 81);
    ctx.bezierCurveTo(54, 48, 86, 30, 113, 30);
    ctx.bezierCurveTo(144, 30, 174, 48, 191, 76);
    ctx.bezierCurveTo(182, 115, 154, 149, 112, 150);
    ctx.bezierCurveTo(72, 151, 45, 118, 34, 81);
    ctx.closePath();
  }

  /**
   * Small inline lips badge next to "too good not to snap"
   */
  function drawMiniLipsIcon(ctx, x, y, w, monochrome = false) {
    const h = w * 0.58;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = monochrome ? "#000000" : "#E63759";
    ctx.beginPath();
    ctx.moveTo(0, h * 0.45);
    ctx.quadraticCurveTo(w * 0.25, 0, w * 0.45, h * 0.16);
    ctx.quadraticCurveTo(w * 0.5, h * 0.22, w * 0.55, h * 0.16);
    ctx.quadraticCurveTo(w * 0.75, 0, w, h * 0.45);
    ctx.quadraticCurveTo(w * 0.78, h, w * 0.5, h);
    ctx.quadraticCurveTo(w * 0.22, h, 0, h * 0.45);
    ctx.closePath();
    ctx.fill();

    // Inner mouth slit
    ctx.fillStyle = "#FFFFFF";
    ctx.beginPath();
    ctx.ellipse(w * 0.5, h * 0.48, w * 0.27, h * 0.13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /**
   * Draws sourceCanvas cropped (cover fit) into target rect (dx, dy, dw, dh).
   */
  function drawCoverImage(ctx, imgCanvas, dx, dy, dw, dh) {
    const sw = imgCanvas.width;
    const sh = imgCanvas.height;
    const srcRatio = sw / sh;
    const dstRatio = dw / dh;
    let sx = 0, sy = 0, sWidth = sw, sHeight = sh;

    if (srcRatio > dstRatio) {
      sWidth = sh * dstRatio;
      sx = (sw - sWidth) / 2;
    } else {
      sHeight = sw / dstRatio;
      sy = (sh - sHeight) / 2;
    }
    ctx.drawImage(imgCanvas, sx, sy, sWidth, sHeight, dx, dy, dw, dh);
  }

  /**
   * High-contrast B&W Dithering optimized for 203 DPI thermal receipt printing.
   * Supports "atkinson" (preserves facial highlights & crisp edges) and "floyd-steinberg".
   */
  function applyDithering(imageData, method = "atkinson", opts = {}) {
    const { width, height, data } = imageData;
    const contrast = opts.contrast != null ? opts.contrast : 1.16;
    const brightness = opts.brightness != null ? opts.brightness : 10;
    const gamma = opts.gamma != null ? opts.gamma : 1.08;

    // Build luminance float buffer
    const lum = new Float32Array(width * height);
    for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
      // Perceptual luminance
      let g = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      // Gamma lift for thermal midtones
      g = 255 * Math.pow(Math.max(0, Math.min(255, g)) / 255, 1 / gamma);
      // Contrast + brightness around 128
      g = (g - 128) * contrast + 128 + brightness;
      lum[i] = Math.max(0, Math.min(255, g));
    }

    const isAtkinson = method !== "floyd-steinberg";

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const oldVal = lum[idx];
        const newVal = oldVal < 128 ? 0 : 255;
        const err = oldVal - newVal;

        const p = idx * 4;
        data[p] = newVal;
        data[p + 1] = newVal;
        data[p + 2] = newVal;
        data[p + 3] = 255;

        if (isAtkinson) {
          // Atkinson distributes 6/8 (75%) of quantization error, keeping portraits bright
          const e = err / 8;
          if (x + 1 < width) lum[idx + 1] += e;
          if (x + 2 < width) lum[idx + 2] += e;
          if (y + 1 < height) {
            if (x - 1 >= 0) lum[idx + width - 1] += e;
            lum[idx + width] += e;
            if (x + 1 < width) lum[idx + width + 1] += e;
          }
          if (y + 2 < height) {
            lum[idx + width * 2] += e;
          }
        } else {
          // Floyd-Steinberg (full error diffusion)
          if (x + 1 < width) lum[idx + 1] += (err * 7) / 16;
          if (y + 1 < height) {
            if (x - 1 >= 0) lum[idx + width - 1] += (err * 3) / 16;
            lum[idx + width] += (err * 5) / 16;
            if (x + 1 < width) lum[idx + width + 1] += (err * 1) / 16;
          }
        }
      }
    }
    return imageData;
  }

  /**
   * Composes the full BSFC photostrip matching `printed layout.jpg`.
   *
   * @param {Object} params
   * @param {HTMLCanvasElement} params.photoCanvas - Raw captured photo canvas
   * @param {string} params.qrText - URL encoded in the corner QR code
   * @param {boolean} params.thermal - True for 1-bit dithered 80mm thermal output
   * @param {number} params.width - Output canvas width (576 for Epson TM-T20III, 1080 for digital)
   * @param {string} params.ditherMethod - "atkinson" | "floyd-steinberg"
   */
  function composeStripCanvas({
    photoCanvas,
    qrText,
    thermal = false,
    width = 1080,
    ditherMethod = "atkinson",
    ditherOpts = {}
  }) {
    const cfg = global.BSFC_CONFIG || {};
    const branding = cfg.branding || {
      tagline: "too good not to snap",
      handle: "@bsfcollective",
      address: "2440 Bancroft Way #102, Berkeley, CA 94704"
    };

    const height = Math.round(width * 1.28); // Matches printed layout.jpg aspect ratio
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");

    const s = width / 1080; // Scale relative to 1080px reference layout

    // Outer frame background:
    // Color digital uses warm off-white paper (#F1F1EE); thermal uses pure white (#FFFFFF)
    // so the receipt border doesn't get speckled with gray dithering dots.
    ctx.fillStyle = thermal ? "#FFFFFF" : "#F1F1EE";
    ctx.fillRect(0, 0, width, height);

    // Architectural border geometry matching `printed layout.jpg`
    const outerPadX = Math.round(62 * s);
    const outerPadTop = Math.round(58 * s);
    const photoW = width - outerPadX * 2;
    const photoH = Math.round(photoW * 0.965);

    const ruleColor = thermal ? "#000000" : "#CECECA";
    const ruleWidth = Math.max(2, Math.round(4 * s));

    // Horizontal & vertical structural frame lines extending across the strip
    ctx.strokeStyle = ruleColor;
    ctx.lineWidth = ruleWidth;

    const topRuleY = outerPadTop - Math.round(20 * s);
    const bottomRuleY = outerPadTop + photoH + Math.round(20 * s);
    const leftRuleX = outerPadX - Math.round(20 * s);
    const rightRuleX = outerPadX + photoW + Math.round(20 * s);

    // Full-width top and bottom outer rails
    ctx.beginPath();
    ctx.moveTo(0, topRuleY);
    ctx.lineTo(width, topRuleY);
    ctx.moveTo(0, bottomRuleY);
    ctx.lineTo(width, bottomRuleY);
    // Full-height left and right rails (stopping at bottom footer rail)
    ctx.moveTo(leftRuleX, 0);
    ctx.lineTo(leftRuleX, bottomRuleY);
    ctx.moveTo(rightRuleX, 0);
    ctx.lineTo(rightRuleX, bottomRuleY);
    ctx.stroke();

    // Inner photo rectangle border
    ctx.strokeRect(
      outerPadX - Math.round(2 * s),
      outerPadTop - Math.round(2 * s),
      photoW + Math.round(4 * s),
      photoH + Math.round(4 * s)
    );

    // Render photo inside frame
    if (photoCanvas) {
      if (thermal) {
        // Render portrait into a temporary buffer, dither ONLY the photo, then stamp
        const temp = document.createElement("canvas");
        temp.width = photoW;
        temp.height = photoH;
        const tctx = temp.getContext("2d");
        tctx.fillStyle = "#FFFFFF";
        tctx.fillRect(0, 0, photoW, photoH);
        drawCoverImage(tctx, photoCanvas, 0, 0, photoW, photoH);
        const imgData = tctx.getImageData(0, 0, photoW, photoH);
        applyDithering(imgData, ditherMethod, ditherOpts);
        tctx.putImageData(imgData, 0, 0);
        ctx.drawImage(temp, outerPadX, outerPadTop);
      } else {
        ctx.save();
        ctx.beginPath();
        ctx.rect(outerPadX, outerPadTop, photoW, photoH);
        ctx.clip();
        drawCoverImage(ctx, photoCanvas, outerPadX, outerPadTop, photoW, photoH);
        ctx.restore();
      }
    } else {
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(outerPadX, outerPadTop, photoW, photoH);
    }

    // Overlap BSFC Lips Logo in top-left corner just like `printed layout.jpg`
    const logoWidth = Math.round(330 * s);
    drawBsfcLogo(ctx, Math.round(16 * s), Math.round(14 * s), logoWidth, thermal);

    // Footer metadata & QR Code matching `printed layout.jpg`
    const footerTop = bottomRuleY + Math.round(40 * s);
    const textX = Math.round(52 * s);
    const textColor = "#000000";

    ctx.fillStyle = textColor;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";

    // Line 1: "too good not to snap" + lips icon
    const line1Y = footerTop + Math.round(22 * s);
    ctx.font = `900 ${Math.round(34 * s)}px 'Cooper Black', 'Rockwell', 'Georgia', serif`;
    ctx.fillText(branding.tagline, textX, line1Y);
    const taglineWidth = ctx.measureText(branding.tagline).width;
    drawMiniLipsIcon(
      ctx,
      textX + taglineWidth + Math.round(14 * s),
      line1Y + Math.round(6 * s),
      Math.round(44 * s),
      thermal
    );

    // Line 2: "@bsfcollective"
    const line2Y = line1Y + Math.round(62 * s);
    ctx.font = `900 ${Math.round(34 * s)}px 'Cooper Black', 'Rockwell', 'Georgia', serif`;
    ctx.fillText(branding.handle, textX, line2Y);

    // Line 3: "2440 Bancroft Way #102, Berkeley, CA 94704" (underlined)
    const line3Y = line2Y + Math.round(62 * s);
    ctx.font = `900 ${Math.round(27 * s)}px 'Cooper Black', 'Rockwell', 'Georgia', serif`;
    ctx.fillText(branding.address, textX, line3Y);
    const addrWidth = ctx.measureText(branding.address).width;
    ctx.fillRect(textX, line3Y + Math.round(31 * s), addrWidth, Math.max(2, Math.round(3 * s)));

    // Bottom-right QR Code
    const qrSize = Math.round(198 * s);
    const qrX = width - qrSize - Math.round(42 * s);
    const qrY = footerTop + Math.round(14 * s);
    if (global.BSFCQRCode) {
      global.BSFCQRCode.drawToCanvas(ctx, qrText || cfg.sharing.fallbackQrUrl, {
        x: qrX,
        y: qrY,
        size: qrSize,
        quietZone: 1,
        darkColor: "#000000",
        lightColor: thermal ? "#FFFFFF" : "#F1F1EE"
      });
    }

    return canvas;
  }

  /**
   * Returns crisp inline SVG markup for the BSFC brand lips badge (used in UI modals & live camera overlay)
   */
  function getBsfcLogoSvg() {
    return `
      <svg viewBox="0 0 220 185" xmlns="http://www.w3.org/2000/svg" aria-label="Berkeley Student Food Collective">
        <g transform="rotate(-7 110 92)">
          <path d="M12,86 C32,54 62,14 92,14 C103,14 108,22 112,23 C118,22 125,14 138,15 C168,17 195,50 210,78 C205,118 176,174 114,176 C56,177 25,126 12,86 Z"
                fill="#E5301F" stroke="#B81D11" stroke-width="3"/>
          <path d="M46,36 Q75,19 98,25" fill="none" stroke="#F46655" stroke-width="3" stroke-linecap="round"/>
          <path d="M64,158 Q114,173 158,152" fill="none" stroke="#F46655" stroke-width="3.5" stroke-linecap="round"/>
          <clipPath id="bsfc-mouth-clip">
            <path d="M34,81 C54,48 86,30 113,30 C144,30 174,48 191,76 C182,115 154,149 112,150 C72,151 45,118 34,81 Z"/>
          </clipPath>
          <path d="M34,81 C54,48 86,30 113,30 C144,30 174,48 191,76 C182,115 154,149 112,150 C72,151 45,118 34,81 Z"
                fill="#FFFFFF"/>
          <g clip-path="url(#bsfc-mouth-clip)">
            <path d="M30,56 Q110,34 188,57" fill="none" stroke="#E5301F" stroke-width="2.2"/>
            <line x1="54" y1="22" x2="54" y2="52" stroke="#E5301F" stroke-width="2.2"/>
            <line x1="72" y1="22" x2="72" y2="52" stroke="#E5301F" stroke-width="2.2"/>
            <line x1="91" y1="22" x2="91" y2="52" stroke="#E5301F" stroke-width="2.2"/>
            <line x1="110" y1="22" x2="110" y2="52" stroke="#E5301F" stroke-width="2.2"/>
            <line x1="129" y1="22" x2="129" y2="52" stroke="#E5301F" stroke-width="2.2"/>
            <line x1="148" y1="22" x2="148" y2="52" stroke="#E5301F" stroke-width="2.2"/>
            <line x1="166" y1="22" x2="166" y2="52" stroke="#E5301F" stroke-width="2.2"/>
            <text x="109" y="72" text-anchor="middle" fill="#6BBF2E" font-family="'Arial Black', Impact, sans-serif" font-weight="900" font-size="18.5">BERKELEY</text>
            <text x="109" y="102" text-anchor="middle" fill="#6BBF2E" font-family="Impact, 'Arial Black', sans-serif" font-weight="900" font-size="25" transform="translate(109,102) scale(0.88,1.22) translate(-109,-102)">STUDENT FOOD</text>
            <text x="109" y="135" text-anchor="middle" fill="#6BBF2E" font-family="Impact, 'Arial Black', sans-serif" font-weight="900" font-size="20" transform="translate(109,135) scale(0.95,1.05) translate(-109,-135)">COLLECTIVE</text>
          </g>
        </g>
      </svg>
    `;
  }

  global.BSFCAssets = {
    drawBsfcLogo,
    applyDithering,
    composeStripCanvas,
    getBsfcLogoSvg
  };
})(window);
