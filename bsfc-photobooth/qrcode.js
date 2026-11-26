/**
 * Self-contained Pure JS QR Code Encoder (ISO/IEC 18004 Byte Mode, Versions 1-10)
 * Zero external dependencies — works 100% offline in locked kiosk browsers and
 * draws razor-sharp un-antialiased modules for 203 DPI thermal receipt printing.
 */
(function (global) {
  "use strict";

  // Galois Field GF(256) with primitive polynomial 0x11D
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) {
      EXP[i] = EXP[i - 255];
    }
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  function rsGeneratorPoly(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      const factor = EXP[i];
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], factor);
      }
      poly = next;
    }
    return poly;
  }

  function rsComputeRemainder(data, ecCount) {
    const gen = rsGeneratorPoly(ecCount);
    const res = new Uint8Array(ecCount);
    for (let i = 0; i < data.length; i++) {
      const factor = data[i] ^ res[0];
      for (let j = 0; j < ecCount - 1; j++) {
        res[j] = res[j + 1];
      }
      res[ecCount - 1] = 0;
      for (let j = 0; j < ecCount; j++) {
        res[j] ^= gfMul(gen[j + 1], factor);
      }
    }
    return res;
  }

  // Error correction Level M tables for Versions 1..10
  // Each entry: [totalDataBytes, ecBytesPerBlock, group1Blocks, group1DataBytes, group2Blocks, group2DataBytes]
  const VERSION_M = {
    1: [16, 10, 1, 16, 0, 0],
    2: [28, 16, 1, 28, 0, 0],
    3: [44, 26, 1, 44, 0, 0],
    4: [64, 18, 2, 32, 0, 0],
    5: [86, 24, 2, 43, 0, 0],
    6: [108, 16, 4, 27, 0, 0],
    7: [124, 18, 4, 31, 0, 0],
    8: [154, 22, 2, 38, 2, 39],
    9: [182, 22, 3, 36, 2, 37],
    10: [216, 26, 4, 43, 1, 44]
  };

  // Alignment pattern center coordinates per version
  const ALIGNMENT_POS = {
    1: [],
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
    7: [6, 22, 38],
    8: [6, 24, 42],
    9: [6, 26, 46],
    10: [6, 28, 50]
  };

  // Precomputed 15-bit format strings for EC Level M (00) + mask 0..7 (masked with 0x5412)
  const FORMAT_INFO_M = [
    0x5412, 0x5125, 0x5e7c, 0x5b4b,
    0x45f9, 0x40ce, 0x4f97, 0x4aa0
  ];

  // Precomputed 18-bit version info for versions 7..10
  const VERSION_INFO = {
    7: 0x07c94,
    8: 0x085bc,
    9: 0x09a99,
    10: 0x0a4d3
  };

  function encodeUtf8(str) {
    if (typeof TextEncoder !== "undefined") {
      return Array.from(new TextEncoder().encode(str));
    }
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) {
        bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else {
        bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return bytes;
  }

  function chooseVersion(byteLen) {
    for (let v = 1; v <= 10; v++) {
      const totalDataBytes = VERSION_M[v][0];
      const charCountBits = v <= 9 ? 8 : 16;
      const headerBits = 4 + charCountBits;
      const availableBytes = Math.floor((totalDataBytes * 8 - headerBits) / 8);
      if (byteLen <= availableBytes) return v;
    }
    throw new Error("QR payload too long for Versions 1-10 (" + byteLen + " bytes)");
  }

  function buildCodewords(bytes, version) {
    const [totalData, ecPerBlock, g1Count, g1Data, g2Count, g2Data] = VERSION_M[version];
    const bits = [];
    const pushBits = (val, len) => {
      for (let i = len - 1; i >= 0; i--) {
        bits.push((val >>> i) & 1);
      }
    };

    // Byte mode indicator (0100) + byte length
    pushBits(0b0100, 4);
    pushBits(bytes.length, version <= 9 ? 8 : 16);
    for (const b of bytes) pushBits(b, 8);

    // Terminator (up to 4 zeros)
    const maxBits = totalData * 8;
    const term = Math.min(4, maxBits - bits.length);
    pushBits(0, term);

    // Pad to byte boundary
    while (bits.length % 8 !== 0) bits.push(0);

    // Convert to bytes and add pad bytes 0xEC, 0x11
    const dataBytes = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      dataBytes.push(byte);
    }
    const padBytes = [0xec, 0x11];
    let p = 0;
    while (dataBytes.length < totalData) {
      dataBytes.push(padBytes[p % 2]);
      p++;
    }

    // Split into blocks and generate RS error correction
    const dataBlocks = [];
    const ecBlocks = [];
    let offset = 0;
    for (let i = 0; i < g1Count; i++) {
      const blk = dataBytes.slice(offset, offset + g1Data);
      offset += g1Data;
      dataBlocks.push(blk);
      ecBlocks.push(rsComputeRemainder(blk, ecPerBlock));
    }
    for (let i = 0; i < g2Count; i++) {
      const blk = dataBytes.slice(offset, offset + g2Data);
      offset += g2Data;
      dataBlocks.push(blk);
      ecBlocks.push(rsComputeRemainder(blk, ecPerBlock));
    }

    // Interleave data and EC codewords
    const finalBytes = [];
    const maxDataLen = Math.max(g1Data, g2Data);
    for (let i = 0; i < maxDataLen; i++) {
      for (const blk of dataBlocks) {
        if (i < blk.length) finalBytes.push(blk[i]);
      }
    }
    for (let i = 0; i < ecPerBlock; i++) {
      for (const blk of ecBlocks) {
        finalBytes.push(blk[i]);
      }
    }
    return finalBytes;
  }

  function createMatrix(version) {
    const size = version * 4 + 17;
    const modules = Array.from({ length: size }, () => new Int8Array(size)); // 0/1
    const isFunc = Array.from({ length: size }, () => new Uint8Array(size));  // 1 if reserved

    const setMod = (r, c, val, func = true) => {
      if (r < 0 || c < 0 || r >= size || c >= size) return;
      modules[r][c] = val ? 1 : 0;
      if (func) isFunc[r][c] = 1;
    };

    const drawFinder = (r0, c0) => {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) {
          const r = r0 + dr;
          const c = c0 + dc;
          if (r < 0 || c < 0 || r >= size || c >= size) continue;
          const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
          const isBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
          const isInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          setMod(r, c, inOuter && (isBorder || isInner), true);
        }
      }
    };

    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    // Alignment patterns
    const coords = ALIGNMENT_POS[version];
    for (let i = 0; i < coords.length; i++) {
      for (let j = 0; j < coords.length; j++) {
        const rCenter = coords[i];
        const cCenter = coords[j];
        // Skip overlaps with 3 finder corners
        if (
          (i === 0 && j === 0) ||
          (i === 0 && j === coords.length - 1) ||
          (i === coords.length - 1 && j === 0)
        ) {
          continue;
        }
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const dist = Math.max(Math.abs(dr), Math.abs(dc));
            setMod(rCenter + dr, cCenter + dc, dist === 2 || dist === 0, true);
          }
        }
      }
    }

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
      const bit = i % 2 === 0;
      setMod(6, i, bit, true);
      setMod(i, 6, bit, true);
    }

    // Dark module
    setMod(size - 8, 8, true, true);

    // Reserve format info cells
    for (let i = 0; i < 9; i++) {
      if (i !== 6) {
        isFunc[8][i] = 1;
        isFunc[i][8] = 1;
      }
    }
    for (let i = 0; i < 8; i++) {
      isFunc[8][size - 1 - i] = 1;
      isFunc[size - 1 - i][8] = 1;
    }

    // Reserve & draw version info for v >= 7
    if (version >= 7) {
      const vBits = VERSION_INFO[version];
      for (let i = 0; i < 18; i++) {
        const bit = (vBits >>> i) & 1;
        const a = Math.floor(i / 3);
        const b = (i % 3) + size - 11;
        setMod(a, b, bit, true);
        setMod(b, a, bit, true);
      }
    }

    return { size, modules, isFunc };
  }

  function placeDataBits(matrix, codewords) {
    const { size, modules, isFunc } = matrix;
    let bitIdx = 0;
    const totalBits = codewords.length * 8;
    let upward = true;

    for (let col = size - 1; col >= 1; col -= 2) {
      if (col === 6) col--; // Skip timing column
      for (let step = 0; step < size; step++) {
        const row = upward ? size - 1 - step : step;
        for (let dx = 0; dx < 2; dx++) {
          const c = col - dx;
          if (isFunc[row][c]) continue;
          let bit = 0;
          if (bitIdx < totalBits) {
            const byte = codewords[bitIdx >> 3];
            bit = (byte >>> (7 - (bitIdx & 7))) & 1;
            bitIdx++;
          }
          modules[row][c] = bit;
        }
      }
      upward = !upward;
    }
  }

  function maskBit(maskId, r, c) {
    switch (maskId) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return false;
    }
  }

  function applyFormatInfo(modules, size, maskId) {
    const fmt = FORMAT_INFO_M[maskId];
    for (let i = 0; i < 15; i++) {
      const bit = (fmt >>> i) & 1;
      // Vertical strip
      if (i < 6) modules[i][8] = bit;
      else if (i < 8) modules[i + 1][8] = bit;
      else modules[size - 15 + i][8] = bit;

      // Horizontal strip
      if (i < 8) modules[8][size - 1 - i] = bit;
      else if (i < 9) modules[8][15 - i] = bit;
      else modules[8][14 - i] = bit;
    }
  }

  function evaluatePenalty(modules, size) {
    let penalty = 0;

    // Rule 1: 5+ consecutive same-color modules in row/col
    for (let r = 0; r < size; r++) {
      let runColor = modules[r][0];
      let runLen = 1;
      for (let c = 1; c < size; c++) {
        if (modules[r][c] === runColor) {
          runLen++;
        } else {
          if (runLen >= 5) penalty += 3 + (runLen - 5);
          runColor = modules[r][c];
          runLen = 1;
        }
      }
      if (runLen >= 5) penalty += 3 + (runLen - 5);
    }
    for (let c = 0; c < size; c++) {
      let runColor = modules[0][c];
      let runLen = 1;
      for (let r = 1; r < size; r++) {
        if (modules[r][c] === runColor) {
          runLen++;
        } else {
          if (runLen >= 5) penalty += 3 + (runLen - 5);
          runColor = modules[r][c];
          runLen = 1;
        }
      }
      if (runLen >= 5) penalty += 3 + (runLen - 5);
    }

    // Rule 2: 2x2 blocks of same color
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = modules[r][c];
        if (
          v === modules[r][c + 1] &&
          v === modules[r + 1][c] &&
          v === modules[r + 1][c + 1]
        ) {
          penalty += 3;
        }
      }
    }

    // Rule 4: Dark ratio balance
    let dark = 0;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (modules[r][c]) dark++;
      }
    }
    const pct = (dark * 100) / (size * size);
    const prev5 = Math.abs(Math.floor(pct / 5) * 5 - 50) / 5;
    const next5 = Math.abs(Math.ceil(pct / 5) * 5 - 50) / 5;
    penalty += Math.min(prev5, next5) * 10;

    return penalty;
  }

  function generateMatrix(text) {
    const bytes = encodeUtf8(String(text || ""));
    const version = chooseVersion(bytes.length);
    const codewords = buildCodewords(bytes, version);
    const base = createMatrix(version);
    placeDataBits(base, codewords);

    let bestMask = 0;
    let bestScore = Infinity;
    let bestModules = null;

    for (let m = 0; m < 8; m++) {
      const candidate = base.modules.map((row) => new Int8Array(row));
      for (let r = 0; r < base.size; r++) {
        for (let c = 0; c < base.size; c++) {
          if (!base.isFunc[r][c] && maskBit(m, r, c)) {
            candidate[r][c] ^= 1;
          }
        }
      }
      applyFormatInfo(candidate, base.size, m);
      const score = evaluatePenalty(candidate, base.size);
      if (score < bestScore) {
        bestScore = score;
        bestMask = m;
        bestModules = candidate;
      }
    }

    return { size: base.size, modules: bestModules, version, mask: bestMask };
  }

  function drawToCanvas(canvasOrCtx, text, options = {}) {
    const qr = generateMatrix(text);
    const x0 = options.x || 0;
    const y0 = options.y || 0;
    const totalSize = options.size || 200;
    const quietZone = options.quietZone != null ? options.quietZone : 2;
    const darkColor = options.darkColor || "#000000";
    const lightColor = options.lightColor || "#FFFFFF";

    let ctx;
    if (typeof canvasOrCtx.getContext === "function") {
      canvasOrCtx.width = totalSize;
      canvasOrCtx.height = totalSize;
      ctx = canvasOrCtx.getContext("2d");
    } else {
      ctx = canvasOrCtx;
    }

    const moduleCount = qr.size + quietZone * 2;
    // Snap module size to integer pixels when possible for ultra-crisp thermal printing
    const cell = Math.max(1, Math.floor(totalSize / moduleCount));
    const renderedSize = cell * moduleCount;
    const offsetX = x0 + Math.floor((totalSize - renderedSize) / 2);
    const offsetY = y0 + Math.floor((totalSize - renderedSize) / 2);

    ctx.save();
    ctx.fillStyle = lightColor;
    ctx.fillRect(x0, y0, totalSize, totalSize);

    ctx.fillStyle = darkColor;
    for (let r = 0; r < qr.size; r++) {
      for (let c = 0; c < qr.size; c++) {
        if (qr.modules[r][c]) {
          ctx.fillRect(
            offsetX + (c + quietZone) * cell,
            offsetY + (r + quietZone) * cell,
            cell,
            cell
          );
        }
      }
    }
    ctx.restore();
    return qr;
  }

  global.BSFCQRCode = {
    generateMatrix,
    drawToCanvas
  };
})(window);
