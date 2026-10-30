/**
 * Aegis AI File Manager — Zero-Knowledge End-to-End Encryption (E2EE) Engine
 *
 * Security Architecture:
 * 1. Key Derivation: PBKDF2-HMAC-SHA256 (210,000 iterations) derives 512 bits:
 *    - First 256 bits  -> AES-256-GCM master encryption key (NEVER leaves client).
 *    - Second 256 bits -> SHA-256 -> 128-bit hex `X-Vault-Id` (opaque server namespace).
 * 2. File & Metadata Encryption:
 *    - Every file is parsed & analyzed by the AI reader locally in the browser BEFORE encryption.
 *    - File bytes are encrypted into an `AE2E\x01` envelope:
 *      [4B "AE2E"][1B version=0x01][12B random IV][AES-256-GCM ciphertext + 16B auth tag].
 *    - Sensitive metadata (filename, extracted text, summary, tags, category) is encrypted
 *      separately with AES-256-GCM + fresh 12B random IV into `encrypted_meta`.
 * 3. End-to-End Encrypted Sharing:
 *    - Generates a fresh ephemeral 256-bit AES-GCM key per shared file.
 *    - Places the key strictly inside the URL `#` fragment (`#share=<id>&key=<secret>`),
 *      which browsers NEVER transmit in HTTP requests to the server.
 */
(function () {
  'use strict';

  const MAGIC = new Uint8Array([0x41, 0x45, 0x32, 0x45, 0x01]); // "AE2E\x01"
  const KDF_SALT = 'aegis-e2ee-vault-salt-v1';
  const KDF_ITERATIONS = 210000;
  const SESSION_STORAGE_KEY = 'aegis_e2ee_session_v1';
  const DEVICE_STORAGE_KEY = 'aegis_e2ee_device_v1';
  const IS_ANDROID = location.hostname === 'appassets.androidplatform.net' || Boolean(window.AegisNative);

  const encUtf8 = (s) => new TextEncoder().encode(s);
  const decUtf8 = (u8) => new TextDecoder().decode(u8);

  function toHex(u8) {
    let out = '';
    for (let i = 0; i < u8.length; i++) out += u8[i].toString(16).padStart(2, '0');
    return out;
  }

  function toBase64Url(u8) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(str) {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function randomBytes(len) {
    const b = new Uint8Array(len);
    crypto.getRandomValues(b);
    return b;
  }

  // ===========================================================================
  // Pure-JS NIST SHA-256 / PBKDF2 / AES-256-GCM Fallback (for non-HTTPS LAN IPs)
  // Produces byte-for-byte identical output to WebCrypto (`window.crypto.subtle`).
  // ===========================================================================
  const PureCrypto = (function () {
    const K256 = new Uint32Array([
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    ]);

    function sha256(msg) {
      let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,
          h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
      const bitLen = msg.length * 8;
      const padLen = ((msg.length + 9 + 63) & ~63);
      const buf = new Uint8Array(padLen);
      buf.set(msg);
      buf[msg.length] = 0x80;
      const dv = new DataView(buf.buffer);
      dv.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
      dv.setUint32(padLen - 4, bitLen >>> 0, false);
      const W = new Uint32Array(64);
      for (let off = 0; off < padLen; off += 64) {
        for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4, false);
        for (let i = 16; i < 64; i++) {
          const x = W[i - 15], y = W[i - 2];
          const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
          const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
          W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
        }
        let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
        for (let i = 0; i < 64; i++) {
          const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
          const ch = (e & f) ^ (~e & g);
          const t1 = (h + S1 + ch + K256[i] + W[i]) >>> 0;
          const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
          const maj = (a & b) ^ (a & c) ^ (b & c);
          const t2 = (S0 + maj) >>> 0;
          h=g; g=f; f=e; e=(d + t1) >>> 0; d=c; c=b; b=a; a=(t1 + t2) >>> 0;
        }
        h0=(h0+a)>>>0; h1=(h1+b)>>>0; h2=(h2+c)>>>0; h3=(h3+d)>>>0;
        h4=(h4+e)>>>0; h5=(h5+f)>>>0; h6=(h6+g)>>>0; h7=(h7+h)>>>0;
      }
      const out = new Uint8Array(32);
      const odv = new DataView(out.buffer);
      [h0,h1,h2,h3,h4,h5,h6,h7].forEach((v, i) => odv.setUint32(i * 4, v, false));
      return out;
    }

    function pbkdf2Sha256(passwordBytes, saltBytes, iterations, dkLen) {
      let key = passwordBytes.length > 64 ? sha256(passwordBytes) : passwordBytes;
      const ipad = new Uint8Array(64), opad = new Uint8Array(64);
      for (let i = 0; i < 64; i++) {
        const kb = i < key.length ? key[i] : 0;
        ipad[i] = kb ^ 0x36;
        opad[i] = kb ^ 0x5c;
      }
      const hmac = (data) => {
        const inner = new Uint8Array(64 + data.length);
        inner.set(ipad); inner.set(data, 64);
        const ih = sha256(inner);
        const outer = new Uint8Array(96);
        outer.set(opad); outer.set(ih, 64);
        return sha256(outer);
      };
      const blocks = Math.ceil(dkLen / 32);
      const out = new Uint8Array(blocks * 32);
      const saltBlock = new Uint8Array(saltBytes.length + 4);
      saltBlock.set(saltBytes);
      const sbv = new DataView(saltBlock.buffer);
      for (let b = 1; b <= blocks; b++) {
        sbv.setUint32(saltBytes.length, b, false);
        let u = hmac(saltBlock);
        const t = new Uint8Array(u);
        for (let c = 1; c < iterations; c++) {
          u = hmac(u);
          for (let j = 0; j < 32; j++) t[j] ^= u[j];
        }
        out.set(t, (b - 1) * 32);
      }
      return out.subarray(0, dkLen);
    }

    // AES-256 S-Box & Rcon
    const SBOX = new Uint8Array(256);
    (function initAesTables() {
      const p = new Uint8Array(256), q = new Uint8Array(256);
      let x = 1;
      for (let i = 0; i < 255; i++) {
        p[i] = x; q[x] = i;
        x ^= (x << 1) ^ ((x & 0x80) ? 0x11b : 0);
      }
      p[255] = 1;
      SBOX[0] = 0x63;
      for (let i = 1; i < 256; i++) {
        let y = p[255 - q[i]];
        y ^= ((y << 1) | (y >>> 7)) ^ ((y << 2) | (y >>> 6)) ^ ((y << 3) | (y >>> 5)) ^ ((y << 4) | (y >>> 4)) ^ 0x63;
        SBOX[i] = y & 0xff;
      }
    })();

    function expandKey256(key32) {
      const w = new Uint8Array(240);
      w.set(key32);
      let rcon = 1;
      const t = new Uint8Array(4);
      for (let i = 32; i < 240; i += 4) {
        t.set(w.subarray(i - 4, i));
        if (i % 32 === 0) {
          const tmp = SBOX[t[0]];
          t[0] = SBOX[t[1]] ^ rcon; t[1] = SBOX[t[2]]; t[2] = SBOX[t[3]]; t[3] = tmp;
          rcon = (rcon << 1) ^ ((rcon & 0x80) ? 0x11b : 0);
        } else if (i % 32 === 16) {
          for (let k = 0; k < 4; k++) t[k] = SBOX[t[k]];
        }
        for (let k = 0; k < 4; k++) w[i + k] = w[i - 32 + k] ^ t[k];
      }
      return w;
    }

    const xtime = (a) => ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff;

    function aes256Block(rk, in16, out16) {
      const s = new Uint8Array(16), n = new Uint8Array(16);
      for (let i = 0; i < 16; i++) s[i] = in16[i] ^ rk[i];
      for (let r = 1; r <= 14; r++) {
        const ro = r * 16;
        // SubBytes + ShiftRows
        n[0]=SBOX[s[0]];  n[1]=SBOX[s[5]];  n[2]=SBOX[s[10]]; n[3]=SBOX[s[15]];
        n[4]=SBOX[s[4]];  n[5]=SBOX[s[9]];  n[6]=SBOX[s[14]]; n[7]=SBOX[s[3]];
        n[8]=SBOX[s[8]];  n[9]=SBOX[s[13]]; n[10]=SBOX[s[2]]; n[11]=SBOX[s[7]];
        n[12]=SBOX[s[12]];n[13]=SBOX[s[1]]; n[14]=SBOX[s[6]]; n[15]=SBOX[s[11]];
        if (r < 14) {
          for (let c = 0; c < 16; c += 4) {
            const a0=n[c], a1=n[c+1], a2=n[c+2], a3=n[c+3];
            const t = a0 ^ a1 ^ a2 ^ a3;
            s[c]   = a0 ^ t ^ xtime(a0 ^ a1) ^ rk[ro + c];
            s[c+1] = a1 ^ t ^ xtime(a1 ^ a2) ^ rk[ro + c + 1];
            s[c+2] = a2 ^ t ^ xtime(a2 ^ a3) ^ rk[ro + c + 2];
            s[c+3] = a3 ^ t ^ xtime(a3 ^ a0) ^ rk[ro + c + 3];
          }
        } else {
          for (let i = 0; i < 16; i++) out16[i] = n[i] ^ rk[ro + i];
        }
      }
    }

    function gfMul(x, h) {
      const z = new Uint8Array(16), v = new Uint8Array(h);
      for (let i = 0; i < 16; i++) {
        const xi = x[i];
        for (let bit = 7; bit >= 0; bit--) {
          if ((xi >>> bit) & 1) {
            for (let k = 0; k < 16; k++) z[k] ^= v[k];
          }
          const lsb = v[15] & 1;
          for (let k = 15; k > 0; k--) v[k] = (v[k] >>> 1) | ((v[k - 1] & 1) << 7);
          v[0] = (v[0] >>> 1) ^ (lsb ? 0xe1 : 0);
        }
      }
      return z;
    }

    function ghash(H, cipherBytes) {
      let y = new Uint8Array(16);
      const block = new Uint8Array(16);
      for (let off = 0; off < cipherBytes.length; off += 16) {
        block.fill(0);
        block.set(cipherBytes.subarray(off, Math.min(off + 16, cipherBytes.length)));
        for (let k = 0; k < 16; k++) y[k] ^= block[k];
        y = gfMul(y, H);
      }
      // 64-bit AAD bitlen (0) || 64-bit ciphertext bitlen
      block.fill(0);
      const bitLen = cipherBytes.length * 8;
      const dv = new DataView(block.buffer);
      dv.setUint32(8, Math.floor(bitLen / 0x100000000), false);
      dv.setUint32(12, bitLen >>> 0, false);
      for (let k = 0; k < 16; k++) y[k] ^= block[k];
      return gfMul(y, H);
    }

    function gctr(rk, j0, input) {
      const out = new Uint8Array(input.length);
      const ctr = new Uint8Array(j0);
      const dv = new DataView(ctr.buffer);
      const ks = new Uint8Array(16);
      let count = (dv.getUint32(12, false) + 1) >>> 0;
      for (let off = 0; off < input.length; off += 16) {
        dv.setUint32(12, count, false);
        count = (count + 1) >>> 0;
        aes256Block(rk, ctr, ks);
        const lim = Math.min(16, input.length - off);
        for (let k = 0; k < lim; k++) out[off + k] = input[off + k] ^ ks[k];
      }
      return out;
    }

    function aes256GcmEncrypt(key32, iv12, plain) {
      const rk = expandKey256(key32);
      const H = new Uint8Array(16);
      aes256Block(rk, H, H);
      const j0 = new Uint8Array(16);
      j0.set(iv12); j0[15] = 1;
      const cipher = gctr(rk, j0, plain);
      const s = ghash(H, cipher);
      const ej0 = new Uint8Array(16);
      aes256Block(rk, j0, ej0);
      const out = new Uint8Array(cipher.length + 16);
      out.set(cipher);
      for (let i = 0; i < 16; i++) out[cipher.length + i] = s[i] ^ ej0[i];
      return out;
    }

    function aes256GcmDecrypt(key32, iv12, cipherAndTag) {
      if (cipherAndTag.length < 16) throw new Error('Ciphertext too short');
      const rk = expandKey256(key32);
      const H = new Uint8Array(16);
      aes256Block(rk, H, H);
      const j0 = new Uint8Array(16);
      j0.set(iv12); j0[15] = 1;
      const cipher = cipherAndTag.subarray(0, cipherAndTag.length - 16);
      const tag = cipherAndTag.subarray(cipherAndTag.length - 16);
      const s = ghash(H, cipher);
      const ej0 = new Uint8Array(16);
      aes256Block(rk, j0, ej0);
      let diff = 0;
      for (let i = 0; i < 16; i++) diff |= (tag[i] ^ (s[i] ^ ej0[i]));
      if (diff !== 0) {
        throw new Error('AES-256-GCM integrity verification failed (wrong key or tampered ciphertext)');
      }
      return gctr(rk, j0, cipher);
    }

    return { sha256, pbkdf2Sha256, aes256GcmEncrypt, aes256GcmDecrypt };
  })();

  // ===========================================================================
  // Unified Crypto Wrapper (Native WebCrypto first, PureCrypto fallback)
  // ===========================================================================
  const HAS_SUBTLE = Boolean(window.crypto && window.crypto.subtle);

  async function sha256Bytes(u8) {
    if (HAS_SUBTLE) return new Uint8Array(await crypto.subtle.digest('SHA-256', u8));
    return PureCrypto.sha256(u8);
  }

  async function deriveMasterMaterial(passphrase) {
    const passBytes = encUtf8(passphrase);
    const saltBytes = encUtf8(KDF_SALT);
    let bits64;
    if (HAS_SUBTLE) {
      const baseKey = await crypto.subtle.importKey('raw', passBytes, 'PBKDF2', false, ['deriveBits']);
      const derived = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: saltBytes, iterations: KDF_ITERATIONS, hash: 'SHA-256' },
        baseKey,
        512
      );
      bits64 = new Uint8Array(derived);
    } else {
      bits64 = PureCrypto.pbkdf2Sha256(passBytes, saltBytes, KDF_ITERATIONS, 64);
    }
    const rawEncKey = bits64.slice(0, 32);
    const vaultHash = await sha256Bytes(bits64.slice(32, 64));
    const vaultId = toHex(vaultHash.subarray(0, 16)); // 32 hex chars
    const fpHash = await sha256Bytes(encUtf8('aegis-fp:' + toBase64Url(rawEncKey)));
    const fpHex = toHex(fpHash.subarray(0, 6)).toUpperCase();
    const keyFingerprint = `AE2E-${fpHex.slice(0,4)}-${fpHex.slice(4,8)}-${fpHex.slice(8,12)}`;
    return { rawEncKey, vaultId, keyFingerprint };
  }

  async function aesGcmEncryptRaw(rawKey32, iv12, plainU8) {
    if (HAS_SUBTLE) {
      const ck = await crypto.subtle.importKey('raw', rawKey32, { name: 'AES-GCM' }, false, ['encrypt']);
      const buf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv12, tagLength: 128 }, ck, plainU8);
      return new Uint8Array(buf);
    }
    return PureCrypto.aes256GcmEncrypt(rawKey32, iv12, plainU8);
  }

  async function aesGcmDecryptRaw(rawKey32, iv12, cipherWithTagU8) {
    if (HAS_SUBTLE) {
      const ck = await crypto.subtle.importKey('raw', rawKey32, { name: 'AES-GCM' }, false, ['decrypt']);
      try {
        const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv12, tagLength: 128 }, ck, cipherWithTagU8);
        return new Uint8Array(buf);
      } catch (e) {
        throw new Error('Decryption failed: wrong encryption key or tampered data.');
      }
    }
    return PureCrypto.aes256GcmDecrypt(rawKey32, iv12, cipherWithTagU8);
  }

  async function encryptBinaryEnvelope(plainU8, rawKey32) {
    const iv = randomBytes(12);
    const cipher = await aesGcmEncryptRaw(rawKey32, iv, plainU8);
    const env = new Uint8Array(5 + 12 + cipher.length);
    env.set(MAGIC, 0);
    env.set(iv, 5);
    env.set(cipher, 17);
    return env;
  }

  async function decryptBinaryEnvelope(envU8, rawKey32) {
    if (envU8.length < 33) throw new Error('Invalid encrypted file envelope (too short)');
    for (let i = 0; i < 5; i++) {
      if (envU8[i] !== MAGIC[i]) throw new Error('Invalid AE2E encryption header');
    }
    const iv = envU8.subarray(5, 17);
    const cipher = envU8.subarray(17);
    return aesGcmDecryptRaw(rawKey32, iv, cipher);
  }

  async function encryptJsonMeta(obj, rawKey32) {
    const iv = randomBytes(12);
    const plain = encUtf8(JSON.stringify(obj));
    const cipher = await aesGcmEncryptRaw(rawKey32, iv, plain);
    const packed = new Uint8Array(12 + cipher.length);
    packed.set(iv, 0);
    packed.set(cipher, 12);
    return toBase64Url(packed);
  }

  async function decryptJsonMeta(b64url, rawKey32) {
    const packed = fromBase64Url(b64url);
    if (packed.length < 28) throw new Error('Invalid encrypted metadata');
    const iv = packed.subarray(0, 12);
    const cipher = packed.subarray(12);
    const plain = await aesGcmDecryptRaw(rawKey32, iv, cipher);
    return JSON.parse(decUtf8(plain));
  }

  // ===========================================================================
  // Client-Side Document Reader & AI Context Segregation (Runs BEFORE Encryption)
  // ===========================================================================
  const TEXT_EXT = new Set([
    '.txt', '.md', '.markdown', '.csv', '.json', '.log', '.py', '.js', '.jsx', '.ts', '.tsx',
    '.html', '.css', '.xml', '.yaml', '.yml', '.sql', '.sh', '.bat', '.ini', '.conf', '.env', '.rst'
  ]);
  const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
  const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac']);
  const VIDEO_EXT = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);
  const ARCHIVE_EXT = new Set(['.zip', '.tar', '.gz', '.rar', '.7z']);

  const extOf = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i).toLowerCase() : ''; };
  const baseOf = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(0, i) : name; };

  function categorizeFileType(filename) {
    const e = extOf(filename);
    if (['.pdf', '.doc', '.docx', '.txt', '.rtf', '.odt', '.epub', '.pages', '.md'].includes(e)) return 'Document';
    if (IMAGE_EXT.has(e)) return 'Image';
    if (['.py', '.js', '.jsx', '.ts', '.tsx', '.html', '.css', '.json', '.xml', '.yaml', '.yml', '.sql', '.sh', '.bat'].includes(e)) return 'Code & Data';
    if (['.csv', '.xls', '.xlsx', '.tsv'].includes(e)) return 'Spreadsheet';
    if (ARCHIVE_EXT.has(e)) return 'Archive';
    if (AUDIO_EXT.has(e) || VIDEO_EXT.has(e)) return 'Media';
    return 'Other';
  }

  async function readPdf(arrayBuffer) {
    if (!window.pdfjsLib) return '[PDF parser not available]';
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = IS_ANDROID ? 'vendor/pdf.worker.min.js' : '/static/vendor/pdf.worker.min.js';
    const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
    const pages = [];
    for (let i = 1; i <= Math.min(pdf.numPages, 20); i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      let line = '', text = '';
      for (const item of content.items) {
        line += item.str;
        if (item.hasEOL) { text += line + '\n'; line = ''; }
      }
      text += line;
      if (text.trim()) pages.push(text);
    }
    return pages.join('\n\n');
  }

  async function readDocx(arrayBuffer) {
    if (!window.JSZip) return '[Word docx parser not available]';
    const zip = await window.JSZip.loadAsync(arrayBuffer.slice(0));
    const xmlFile = zip.file('word/document.xml');
    if (!xmlFile) return '[DOCX Parsing Notice: missing document.xml]';
    const xml = new DOMParser().parseFromString(await xmlFile.async('string'), 'application/xml');
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const paras = [];
    for (const p of xml.getElementsByTagNameNS(W, 'p')) {
      const t = Array.from(p.getElementsByTagNameNS(W, 't')).map(n => n.textContent).join('');
      if (t.trim()) paras.push(t);
    }
    return paras.join('\n\n');
  }

  async function extractDocumentText(arrayBuffer, filename, maxChars = 15000) {
    const e = extOf(filename);
    let text = '';
    try {
      if (e === '.pdf') text = await readPdf(arrayBuffer);
      else if (e === '.docx') text = await readDocx(arrayBuffer);
      else if (e === '.doc') text = '[Word binary .doc document]';
      else if (TEXT_EXT.has(e)) text = decUtf8(new Uint8Array(arrayBuffer)).slice(0, maxChars);
      else if (IMAGE_EXT.has(e)) text = `[Image Asset: ${filename} - ${arrayBuffer.byteLength} bytes. Visual content file.]`;
      else {
        const head = new Uint8Array(arrayBuffer.slice(0, Math.min(1024, arrayBuffer.byteLength)));
        const latin = Array.from(head, b => String.fromCharCode(b)).join('');
        const parts = latin.match(/[ -~]{4,}/g);
        text = parts ? parts.slice(0, 30).join(' ') : `[Binary/Data File: ${filename}]`;
      }
    } catch (err) {
      text = `[Parsing Notice: ${err.message || err}]`;
    }
    const cleaned = text.replace(/\s+/g, ' ').trim();
    const words = cleaned ? cleaned.split(' ').length : 0;
    return {
      text: text.slice(0, maxChars),
      word_count: words,
      reading_time_minutes: words > 0 ? Math.max(1, Math.ceil(words / 200)) : 0
    };
  }

  const CONTEXT_CATEGORIES = {
    'Study & Education': { prefix: 'Study', keywords: ['syllabus', 'lecture', 'professor', 'assignment', 'homework', 'exam', 'course',
      'study', 'chapter', 'textbook', 'university', 'college', 'student', 'curriculum', 'theorem', 'quiz', 'class', 'tutorial',
      'semester', 'bibliography', 'physics', 'calculus', 'biology', 'chemistry', 'algorithm', 'cs', 'history', 'notes', 'thesis'] },
    'Finance & Invoices': { prefix: 'Finance', keywords: ['invoice', 'receipt', 'billing', 'payment', 'tax', 'subtotal', 'total', 'amount',
      'balance', 'usd', 'eur', 'inr', 'gbp', 'bank', 'account', 'transaction', 'salary', 'payroll', 'expense', 'budget', 'statement',
      'wire', 'due date', 'remittance', 'credit', 'debit', 'price', 'vat', 'gst', 'financial'] },
    'Work & Projects': { prefix: 'Work', keywords: ['sprint', 'project', 'client', 'roadmap', 'meeting', 'deliverables', 'milestone',
      'agile', 'jira', 'specification', 'architecture', 'status report', 'proposal', 'executive', 'strategy', 'deliverable',
      'stakeholder', 'presentation', 'brief', 'standup', 'kpi', 'okr', 'quarterly', 'team'] },
    'Legal & Identity': { prefix: 'Legal', keywords: ['agreement', 'terms', 'conditions', 'nda', 'non-disclosure', 'contract', 'parties',
      'confidentiality', 'privacy policy', 'license', 'passport', 'signature', 'clause', 'liability', 'governing law', 'jurisdiction',
      'indemnity', 'intellectual property', 'warranties', 'compliance', 'copyright', 'trademark', 'consent'] },
    'Code & Technical': { prefix: 'Tech', keywords: ['def ', 'function ', 'import ', 'const ', 'class ', 'return ', 'endpoint', 'api',
      'docker', 'kubernetes', 'sql', 'database', 'schema', 'repository', 'git', 'config', 'yaml', 'json', 'backend', 'frontend',
      'server', 'null', 'undefined', 'interface'] },
    'Personal & Notes': { prefix: 'Personal', keywords: ['journal', 'diary', 'todo', 'bucket list', 'shopping', 'recipe', 'personal',
      'reminder', 'thought', 'draft', 'family', 'vacation', 'trip', 'reflection', 'hobby', 'daily'] },
  };

  const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const titleCase = (s) => s.toLowerCase().replace(/[a-z]+/g, w => w[0].toUpperCase() + w.slice(1));

  function analyzeDocumentContext(filename, text) {
    const combined = `${filename} ${text.slice(0, 4000)}`.toLowerCase();
    const normalized = combined.replace(/[_.\-]+/g, ' ');
    const fnLower = filename.toLowerCase();

    const scores = {};
    for (const [cat, cfg] of Object.entries(CONTEXT_CATEGORIES)) {
      let score = 0;
      for (const kw of cfg.keywords) {
        const count = (normalized.match(new RegExp('\\b' + reEscape(kw) + '\\b', 'g')) || []).length;
        score += fnLower.includes(kw) ? count * 3 : count;
      }
      scores[cat] = score;
    }
    const ext = extOf(filename);
    if (['.py', '.js', '.ts', '.html', '.css', '.sql', '.sh'].includes(ext)) scores['Code & Technical'] += 15;

    let best = 'Personal & Notes', bestScore = 0;
    for (const [cat, sc] of Object.entries(scores)) if (sc > bestScore) { bestScore = sc; best = cat; }

    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 3);
    let title = '';
    for (const line of lines.slice(0, 8)) {
      const cleaned = line.replace(/[#*_\-=\[\]|]/g, '').trim();
      if (cleaned.length >= 5 && cleaned.length <= 65 && !/^(page|copyright|http|all rights)/i.test(cleaned)) { title = cleaned; break; }
    }
    if (!title) title = titleCase(baseOf(filename).replace(/[_.\-]+/g, ' '));

    const dm = text.match(/\b(20\d{2}[-_/]\d{1,2}(?:[-_/]\d{1,2})?|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Q[1-4])\b/i);
    const now = new Date();
    const datePart = dm ? dm[0].replace(/\//g, '-') : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const prefix = CONTEXT_CATEGORIES[best].prefix;
    let sanitized = title.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (sanitized.length > 35) sanitized = sanitized.slice(0, 35).replace(/_+$/, '');

    const tags = [];
    const catTag = {
      'Study & Education': ['study'],
      'Finance & Invoices': ['finance'],
      'Work & Projects': ['work'],
      'Legal & Identity': ['legal', 'important'],
      'Code & Technical': ['code']
    }[best] || [];
    tags.push(...catTag);
    const isTemp = /\b(receipt|temporary|temp|draft|scratch|cache)\b/.test(normalized);
    if (isTemp) tags.push('temporary');
    if (/\b(urgent|critical|confidential|contract|passport|license|agreement|nda|important)\b/.test(normalized)) {
      if (!(isTemp && normalized.includes('receipt')) && !tags.includes('important')) tags.push('important');
    } else if (/\b(tax return|tax audit|income tax|w2|1099)\b/.test(normalized) && !tags.includes('important')) {
      tags.push('important');
    }
    if (/\b(invoice|billing|bill)\b/.test(combined) && !tags.includes('invoice')) tags.push('invoice');
    const uniqTags = [...new Set(tags)];

    let summary;
    if (lines.length) {
      const cand = lines.slice(0, 2).join('. ');
      summary = cand.length > 200 ? cand.slice(0, 200) + '...' : cand;
    } else {
      summary = `A ${best.toLowerCase()} document with ${text.length} characters.`;
    }

    return {
      context_category: best,
      ai_suggested_name: `${prefix}_${sanitized}_${datePart}${ext}`,
      ai_rename_reason: `Identified topic as '${title}' under ${best} with date reference (${datePart}).`,
      suggested_tags: uniqTags.length ? uniqTags : ['general'],
      summary
    };
  }

  // ===========================================================================
  // Retention Lifecycle Calculator (Client-Side over Decrypted Records)
  // ===========================================================================
  const DAY = 86400000;
  const ageDays = (rec) => rec.created_at ? Math.max(0, Math.floor((Date.now() - new Date(rec.created_at)) / DAY)) : 0;

  function retentionStatus(rec, retentionDays) {
    const tags = (rec.tags || []).map(t => t.toLowerCase());
    const days = ageDays(rec);
    const base = { days_old: days, retention_days: retentionDays };
    if (tags.includes('important') || rec.is_pinned || rec.is_protected) {
      return {
        ...base, status: 'protected', is_protected: true, badge_text: 'Protected', badge_color: 'emerald',
        reason: "Protected by 'important' tag (excluded from cleanup)."
      };
    }
    if (rec.extended_until) {
      const ext = new Date(rec.extended_until);
      if (Date.now() < ext) {
        const left = Math.max(1, Math.floor((ext - Date.now()) / DAY));
        return {
          ...base, status: 'extended', is_protected: false, badge_text: `Extended (${left}d left)`, badge_color: 'blue',
          reason: `Retention extended until ${ext.toDateString()}.`
        };
      }
    }
    const remaining = retentionDays - days;
    if (remaining <= 0) {
      return {
        ...base, status: 'expired', is_protected: false, badge_text: `Expired (${Math.abs(remaining)}d overdue)`, badge_color: 'rose',
        reason: `File is ${days} days old (exceeds ${retentionDays}-day limit). Pending user review to delete.`
      };
    }
    if (remaining <= 7) {
      return {
        ...base, status: 'expiring_soon', is_protected: false, badge_text: `Expires in ${remaining}d`, badge_color: 'amber',
        reason: `File will reach ${retentionDays}-day retention limit in ${remaining} days.`
      };
    }
    return {
      ...base, status: 'active', is_protected: false, badge_text: `Active (${remaining}d left)`, badge_color: 'slate',
      reason: `Active file. ${remaining} days remaining before cleanup review.`
    };
  }

  // ===========================================================================
  // Vault Session State & Transparent Fetch Interceptor
  // ===========================================================================
  let activeSession = null; // { rawEncKey: Uint8Array(32), vaultId: string, keyFingerprint: string }
  const decryptedCache = new Map(); // key: `${id}:${updated_at}` -> sensitiveMeta
  const pendingAndroidImports = [];

  function loadSavedSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_STORAGE_KEY) || localStorage.getItem(DEVICE_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.rawKeyB64 || !parsed.vaultId) return null;
      const rawEncKey = fromBase64Url(parsed.rawKeyB64);
      if (rawEncKey.length !== 32) return null;
      return {
        rawEncKey,
        vaultId: parsed.vaultId,
        keyFingerprint: parsed.keyFingerprint || 'AE2E-VERIFIED'
      };
    } catch (e) {
      return null;
    }
  }

  activeSession = loadSavedSession();

  const underlyingFetch = window.fetch.bind(window);

  async function e2eeServerFetch(path, options = {}) {
    if (!activeSession) throw new Error('Vault is locked. Unlock your E2EE Vault first.');
    const headers = new Headers(options.headers || {});
    headers.set('X-Vault-Id', activeSession.vaultId);
    const res = await underlyingFetch(path, { ...options, headers });
    if (!res.ok) {
      let msg = `Server error (${res.status})`;
      try { const j = await res.json(); if (j && j.detail) msg = j.detail; } catch (e) {}
      throw new Error(msg);
    }
    return res;
  }

  async function loadDecryptedVault() {
    const res = await e2eeServerFetch('/api/e2ee/files');
    const payload = await res.json();
    const rd = parseInt(payload.retention_days || 30, 10);
    const out = [];
    for (const rawRec of payload.files || []) {
      const cacheKey = `${rawRec.id}:${rawRec.updated_at}`;
      let meta = decryptedCache.get(cacheKey);
      if (!meta) {
        try {
          meta = await decryptJsonMeta(rawRec.encrypted_meta, activeSession.rawEncKey);
          decryptedCache.set(cacheKey, meta);
        } catch (err) {
          continue;
        }
      }
      const merged = {
        ...meta,
        id: rawRec.id,
        e2ee: true,
        cipher: rawRec.cipher || 'AES-256-GCM',
        kdf: rawRec.kdf || 'PBKDF2-SHA256-210000',
        size_bytes: meta.plaintext_size_bytes ?? rawRec.size_bytes ?? 0,
        cipher_size_bytes: rawRec.cipher_size_bytes || 0,
        created_at: rawRec.created_at,
        updated_at: rawRec.updated_at,
        extended_until: rawRec.extended_until,
        is_protected: Boolean(rawRec.is_protected)
      };
      merged.retention_info = retentionStatus(merged, rd);
      out.push({ record: merged, raw: rawRec, meta });
    }
    return { retention_days: rd, entries: out };
  }

  async function saveUpdatedMeta(entry, newMeta, extraUpdates = {}) {
    const encrypted_meta = await encryptJsonMeta(newMeta, activeSession.rawEncKey);
    const is_protected = (newMeta.tags || []).some(t => t.toLowerCase() === 'important');
    const res = await e2eeServerFetch(`/api/e2ee/files/${encodeURIComponent(entry.raw.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encrypted_meta, is_protected, ...extraUpdates })
    });
    const updatedRaw = await res.json();
    decryptedCache.set(`${updatedRaw.id}:${updatedRaw.updated_at}`, newMeta);
    return {
      ...newMeta,
      id: updatedRaw.id,
      e2ee: true,
      cipher: 'AES-256-GCM',
      size_bytes: newMeta.plaintext_size_bytes ?? updatedRaw.size_bytes ?? 0,
      created_at: updatedRaw.created_at,
      updated_at: updatedRaw.updated_at,
      extended_until: updatedRaw.extended_until,
      is_protected
    };
  }

  async function handleE2EEUpload(formData) {
    const autoRename = String(formData.get('auto_rename')) === 'true';
    const initialTags = String(formData.get('initial_tags') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const files = formData.getAll('files');
    const uploaded = [];

    for (const file of files) {
      const safeName = (file.name || 'untitled').split(/[\\/]/).pop() || 'untitled';
      const ab = await file.arrayBuffer();
      const plainU8 = new Uint8Array(ab);

      // 1. Local AI reading & semantic segregation BEFORE encryption
      const doc = await extractDocumentText(ab, safeName);
      const ai = analyzeDocumentContext(safeName, doc.text);
      const digest = await sha256Bytes(plainU8);
      const tags = [...new Set([...initialTags, ...(ai.suggested_tags || []).map(t => t.toLowerCase())])];

      const sensitiveMeta = {
        filename: autoRename ? ai.ai_suggested_name : safeName,
        original_filename: safeName,
        mime_type: file.type || 'application/octet-stream',
        file_type: categorizeFileType(safeName),
        extension: extOf(safeName),
        plaintext_size_bytes: plainU8.byteLength,
        context_category: ai.context_category,
        tags,
        ai_summary: ai.summary,
        extracted_text: doc.text,
        ai_suggested_name: ai.ai_suggested_name,
        ai_rename_reason: ai.ai_rename_reason,
        word_count: doc.word_count,
        reading_time_minutes: doc.reading_time_minutes,
        sha256_fingerprint: toHex(digest),
        is_pinned: false
      };

      // 2. Encrypt file bytes & metadata locally with AES-256-GCM
      const cipherEnvelope = await encryptBinaryEnvelope(plainU8, activeSession.rawEncKey);
      const encrypted_meta = await encryptJsonMeta(sensitiveMeta, activeSession.rawEncKey);
      const is_protected = tags.includes('important');

      // 3. Upload ONLY opaque ciphertext (`cipher.enc`) to server
      const outForm = new FormData();
      outForm.append('encrypted_blob', new Blob([cipherEnvelope], { type: 'application/octet-stream' }), 'cipher.enc');
      outForm.append('encrypted_meta', encrypted_meta);
      outForm.append('size_bytes', String(plainU8.byteLength));
      outForm.append('is_protected', String(is_protected));

      const res = await e2eeServerFetch('/api/e2ee/files', { method: 'POST', body: outForm });
      const savedRaw = await res.json();
      decryptedCache.set(`${savedRaw.id}:${savedRaw.updated_at}`, sensitiveMeta);
      uploaded.push({ ...sensitiveMeta, id: savedRaw.id, e2ee: true, size_bytes: plainU8.byteLength, created_at: savedRaw.created_at });
    }

    return { uploaded, count: uploaded.length };
  }

  async function dispatchApiRoute(method, path, q, body) {
    if (!activeSession) {
      // Return empty safe defaults while locked so UI stays clean behind the lock modal
      if (method === 'GET' && path === '/api/files') return [];
      if (method === 'GET' && path === '/api/stats') {
        return { total_files: 0, total_size_bytes: 0, categories: {}, tags_count: {}, retention_days: 30, expired_files_count: 0, protected_files_count: 0 };
      }
      if (method === 'GET' && path === '/api/retention/overview') {
        return { retention_days: 30, counts: { total: 0, expired: 0, expiring_soon: 0, protected: 0, active: 0 }, pending_review_files: [], requires_permission: false };
      }
      throw new Error('Unlock your End-to-End Encrypted Vault first.');
    }

    if (method === 'POST' && path === '/api/files/upload') {
      return handleE2EEUpload(body);
    }

    if (method === 'POST' && path === '/api/retention/settings') {
      const res = await e2eeServerFetch('/api/e2ee/retention/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retention_days: parseInt(body.retention_days, 10) })
      });
      return res.json();
    }

    const { retention_days: rd, entries } = await loadDecryptedVault();
    const byId = new Map(entries.map(e => [e.raw.id, e]));

    if (method === 'GET' && path === '/api/files') {
      let files = entries.map(e => e.record);
      const query = (q.get('query') || '').trim().toLowerCase();
      if (query) {
        files = files.filter(f =>
          [f.filename, f.original_filename, f.context_category, f.ai_summary, f.extracted_text]
            .some(v => (v || '').toLowerCase().includes(query)) ||
          (f.tags || []).some(t => t.toLowerCase().includes(query))
        );
      }
      const ctx = q.get('context'); if (ctx && ctx !== 'All') files = files.filter(f => f.context_category === ctx);
      const type = q.get('type'); if (type && type !== 'All') files = files.filter(f => f.file_type === type);
      const tag = q.get('tag');
      if (tag && tag !== 'All') files = files.filter(f => (f.tags || []).some(t => t.toLowerCase() === tag.toLowerCase()));
      const ret = q.get('retention');
      if (ret && ret !== 'All') {
        files = files.filter(f => ret === 'active' ? ['active', 'extended'].includes(f.retention_info.status) : f.retention_info.status === ret);
      }
      const by = q.get('sort_by') || 'date', dir = q.get('sort_order') === 'asc' ? 1 : -1;
      const key = {
        name: f => (f.filename || '').toLowerCase(),
        size: f => f.size_bytes || 0,
        retention: f => f.retention_info.days_old || 0
      }[by] || (f => f.created_at || '');
      files.sort((a, b) => (key(a) > key(b) ? 1 : key(a) < key(b) ? -1 : 0) * dir);
      return files;
    }

    if (method === 'GET' && path === '/api/stats') {
      const categories = {}, tags_count = {};
      let expired = 0, protectedCount = 0, totalSize = 0;
      for (const { record: f } of entries) {
        totalSize += f.size_bytes || 0;
        categories[f.context_category] = (categories[f.context_category] || 0) + 1;
        for (const t of f.tags || []) tags_count[t] = (tags_count[t] || 0) + 1;
        if (f.retention_info.status === 'expired') expired++;
        else if (f.retention_info.status === 'protected') protectedCount++;
      }
      return {
        total_files: entries.length,
        total_size_bytes: totalSize,
        categories,
        tags_count,
        retention_days: rd,
        expired_files_count: expired,
        protected_files_count: protectedCount
      };
    }

    if (method === 'GET' && path === '/api/retention/overview') {
      const counts = { total: entries.length, expired: 0, expiring_soon: 0, protected: 0, active: 0 };
      const pending = [];
      for (const { record: f } of entries) {
        const st = f.retention_info.status;
        if (st === 'expired') { counts.expired++; pending.push(f); }
        else if (st === 'expiring_soon') counts.expiring_soon++;
        else if (st === 'protected') counts.protected++;
        else counts.active++;
      }
      return { retention_days: rd, counts, pending_review_files: pending, requires_permission: pending.length > 0 };
    }

    if (method === 'POST' && path === '/api/files/batch-ai-rename') {
      const renamed = [];
      for (const id of body.file_ids || []) {
        const entry = byId.get(id);
        if (entry && entry.meta.ai_suggested_name) {
          const newMeta = { ...entry.meta, filename: entry.meta.ai_suggested_name };
          renamed.push(await saveUpdatedMeta(entry, newMeta));
        }
      }
      return { renamed_count: renamed.length, files: renamed };
    }

    if (method === 'POST' && path === '/api/files/batch-delete') {
      for (const id of body.file_ids || []) {
        await e2eeServerFetch(`/api/e2ee/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
      }
      return { deleted_count: (body.file_ids || []).length, ids: body.file_ids || [] };
    }

    if (method === 'POST' && path === '/api/retention/action') {
      const items = [];
      for (const id of body.file_ids || []) {
        const entry = byId.get(id);
        if (!entry) continue;
        if (body.action === 'protect') {
          const tags = [...new Set([...(entry.meta.tags || []), 'important'])];
          const newMeta = { ...entry.meta, tags };
          const encrypted_meta = await encryptJsonMeta(newMeta, activeSession.rawEncKey);
          items.push({ id, encrypted_meta, is_protected: true });
        } else {
          items.push({ id });
        }
      }
      const res = await e2eeServerFetch('/api/e2ee/retention/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: body.action, items, custom_extension_days: body.custom_extension_days || 30 })
      });
      return res.json();
    }

    let m;
    if ((m = path.match(/^\/api\/files\/([^/]+)$/))) {
      const id = decodeURIComponent(m[1]);
      const entry = byId.get(id);
      if (!entry) throw new Error('File not found');
      if (method === 'GET') return entry.record;
      if (method === 'DELETE') {
        await e2eeServerFetch(`/api/e2ee/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
        return { message: 'File deleted successfully', file: entry.record };
      }
    }

    if ((m = path.match(/^\/api\/files\/([^/]+)\/(rename|tags\/add|tags\/remove|tags|set-age)$/)) && method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const entry = byId.get(id);
      if (!entry) throw new Error('File not found');
      switch (m[2]) {
        case 'rename': {
          let name = body.use_ai_suggested ? entry.meta.ai_suggested_name : body.new_name;
          if (!name) throw new Error('Missing new filename');
          if (entry.meta.extension && !name.toLowerCase().endsWith(entry.meta.extension.toLowerCase())) {
            name += entry.meta.extension;
          }
          const updated = await saveUpdatedMeta(entry, { ...entry.meta, filename: name });
          return { message: 'File renamed successfully', file: updated };
        }
        case 'tags/add': {
          const tag = String(body.tag || '').trim().toLowerCase();
          const tags = [...(entry.meta.tags || [])];
          if (tag && !tags.some(t => t.toLowerCase() === tag)) {
            tags.push(tag);
            await saveUpdatedMeta(entry, { ...entry.meta, tags });
          }
          return { tags };
        }
        case 'tags/remove': {
          const target = String(body.tag || '').trim().toLowerCase();
          const tags = (entry.meta.tags || []).filter(t => t.toLowerCase() !== target);
          await saveUpdatedMeta(entry, { ...entry.meta, tags });
          return { tags };
        }
        case 'tags': {
          const tags = [...new Set((body.tags || []).map(t => t.trim().toLowerCase()).filter(Boolean))];
          return saveUpdatedMeta(entry, { ...entry.meta, tags });
        }
        case 'set-age': {
          const simCreated = new Date(Date.now() - body.days_old * DAY).toISOString();
          const updated = await saveUpdatedMeta(entry, entry.meta, { created_at: simCreated, clear_extended_until: true });
          return { message: `File age simulated to ${body.days_old} days`, retention_info: retentionStatus(updated, rd) };
        }
      }
    }

    throw new Error(`Unhandled E2EE route: ${method} ${path}`);
  }

  // Intercept `/api/files*`, `/api/stats`, `/api/retention*` while letting `/api/e2ee/*` & `/api/shares*` pass through
  window.fetch = async function (input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const p = url.pathname;
    if (!p.startsWith('/api/') || p.startsWith('/api/e2ee/') || p.startsWith('/api/shares')) {
      return underlyingFetch(input, init);
    }
    const method = (init.method || 'GET').toUpperCase();
    let body = init.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) {}
    }
    try {
      const data = await dispatchApiRoute(method, p, url.searchParams, body || {});
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (err) {
      return new Response(JSON.stringify({ detail: err.message || String(err) }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  };

  // ===========================================================================
  // Decrypt & Download + Live Server Proof + E2EE Share Link API
  // ===========================================================================
  async function downloadDecrypted(fileId) {
    if (!activeSession) throw new Error('Vault is locked');
    const { entries } = await loadDecryptedVault();
    const entry = entries.find(e => e.raw.id === fileId);
    if (!entry) throw new Error('File not found in vault');

    const res = await e2eeServerFetch(`/api/e2ee/files/${encodeURIComponent(fileId)}/blob`);
    const envU8 = new Uint8Array(await res.arrayBuffer());
    const plainU8 = await decryptBinaryEnvelope(envU8, activeSession.rawEncKey);

    if (entry.meta.sha256_fingerprint) {
      const digest = toHex(await sha256Bytes(plainU8));
      if (digest !== entry.meta.sha256_fingerprint) {
        throw new Error('SHA-256 integrity mismatch after decryption!');
      }
    }

    const mime = entry.meta.mime_type || 'application/octet-stream';
    const filename = entry.meta.filename || 'decrypted_file';

    if (window.AegisNative && typeof window.AegisNative.saveToDownloads === 'function') {
      let bin = '';
      const chunk = 0x8000;
      for (let i = 0; i < plainU8.length; i += chunk) {
        bin += String.fromCharCode.apply(null, plainU8.subarray(i, i + chunk));
      }
      return window.AegisNative.saveToDownloads(filename, mime, btoa(bin));
    }

    const blob = new Blob([plainU8], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return `Decrypted & downloaded "${filename}"`;
  }

  async function getServerProof(fileId) {
    const res = await e2eeServerFetch(`/api/e2ee/files/${encodeURIComponent(fileId)}/proof`);
    return res.json();
  }

  async function createEncryptedShareLink(fileId, expiresInHours = 168, burnAfterDownload = false) {
    if (IS_ANDROID) {
      throw new Error('Web share links require the web app. Use Download to share locally on Android.');
    }
    const { entries } = await loadDecryptedVault();
    const entry = entries.find(e => e.raw.id === fileId);
    if (!entry) throw new Error('File not found');

    // 1. Fetch & decrypt file locally with Vault Key
    const blobRes = await e2eeServerFetch(`/api/e2ee/files/${encodeURIComponent(fileId)}/blob`);
    const plainU8 = await decryptBinaryEnvelope(new Uint8Array(await blobRes.arrayBuffer()), activeSession.rawEncKey);

    // 2. Generate brand-new ephemeral 256-bit Share Key
    const shareKey = randomBytes(32);
    const shareCipherBlob = await encryptBinaryEnvelope(plainU8, shareKey);
    const shareMeta = {
      filename: entry.meta.filename,
      mime_type: entry.meta.mime_type || 'application/octet-stream',
      size_bytes: plainU8.byteLength,
      context_category: entry.meta.context_category || 'Shared Document',
      ai_summary: entry.meta.ai_summary || '',
      sha256_fingerprint: entry.meta.sha256_fingerprint || toHex(await sha256Bytes(plainU8))
    };
    const encryptedShareMeta = await encryptJsonMeta(shareMeta, shareKey);

    // 3. Upload ONLY ciphertext to `/api/shares` (shareKey stays strictly in URL `#` fragment!)
    const fd = new FormData();
    fd.append('encrypted_blob', new Blob([shareCipherBlob], { type: 'application/octet-stream' }), 'share.enc');
    fd.append('encrypted_meta', encryptedShareMeta);
    fd.append('expires_in_hours', String(expiresInHours));
    fd.append('burn_after_download', String(Boolean(burnAfterDownload)));

    const res = await underlyingFetch('/api/shares', { method: 'POST', body: fd });
    if (!res.ok) {
      let msg = 'Failed creating encrypted share';
      try { const j = await res.json(); if (j && j.detail) msg = j.detail; } catch (e) {}
      throw new Error(msg);
    }
    const created = await res.json();
    const keyFragment = toBase64Url(shareKey);
    const url = `${location.origin}${location.pathname}#share=${encodeURIComponent(created.share_id)}&key=${keyFragment}`;
    return {
      url,
      share_id: created.share_id,
      expires_at: created.expires_at,
      burn_after_download: created.burn_after_download,
      filename: entry.meta.filename
    };
  }

  async function inspectIncomingShare(shareId, keyB64Url) {
    const shareKey = fromBase64Url(keyB64Url);
    if (shareKey.length !== 32) throw new Error('Invalid 256-bit share decryption key in URL fragment.');
    const res = await underlyingFetch(`/api/shares/${encodeURIComponent(shareId)}/meta`);
    if (!res.ok) {
      let msg = 'Encrypted share link has expired or already been burned.';
      try { const j = await res.json(); if (j && j.detail) msg = j.detail; } catch (e) {}
      throw new Error(msg);
    }
    const serverInfo = await res.json();
    const decryptedMeta = await decryptJsonMeta(serverInfo.encrypted_meta, shareKey);
    return { serverInfo, meta: decryptedMeta, shareKey };
  }

  async function downloadIncomingShare(shareId, shareKey, meta) {
    const res = await underlyingFetch(`/api/shares/${encodeURIComponent(shareId)}/blob`);
    if (!res.ok) {
      let msg = 'Encrypted share payload has expired or already been burned.';
      try { const j = await res.json(); if (j && j.detail) msg = j.detail; } catch (e) {}
      throw new Error(msg);
    }
    const envU8 = new Uint8Array(await res.arrayBuffer());
    const plainU8 = await decryptBinaryEnvelope(envU8, shareKey);
    if (meta.sha256_fingerprint) {
      const digest = toHex(await sha256Bytes(plainU8));
      if (digest !== meta.sha256_fingerprint) {
        throw new Error('Tamper alert: SHA-256 checksum mismatch!');
      }
    }
    const blob = new Blob([plainU8], { type: meta.mime_type || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = meta.filename || 'shared_decrypted_file';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ===========================================================================
  // Vault Unlock / Lock Lifecycle
  // ===========================================================================
  async function unlockWithPassphrase(passphrase, rememberDevice = true) {
    if (!passphrase || passphrase.trim().length < 6) {
      throw new Error('Passphrase must be at least 6 characters long.');
    }
    const derived = await deriveMasterMaterial(passphrase.trim());
    activeSession = derived;
    decryptedCache.clear();

    const serialized = JSON.stringify({
      rawKeyB64: toBase64Url(derived.rawEncKey),
      vaultId: derived.vaultId,
      keyFingerprint: derived.keyFingerprint
    });
    sessionStorage.setItem(SESSION_STORAGE_KEY, serialized);
    if (rememberDevice) {
      localStorage.setItem(DEVICE_STORAGE_KEY, serialized);
    } else {
      localStorage.removeItem(DEVICE_STORAGE_KEY);
    }

    // Flush any queued Android Share-to-Aegis imports
    while (pendingAndroidImports.length > 0) {
      const item = pendingAndroidImports.shift();
      if (window.aegisImportShared) window.aegisImportShared(item.filename, item.mimeType, item.b64);
    }
    return derived;
  }

  function lockVault() {
    if (activeSession && activeSession.rawEncKey) {
      activeSession.rawEncKey.fill(0);
    }
    activeSession = null;
    decryptedCache.clear();
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    localStorage.removeItem(DEVICE_STORAGE_KEY);
  }

  function generateStrongPassphrase() {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const bytes = randomBytes(16);
    const groups = [];
    for (let g = 0; g < 4; g++) {
      let part = '';
      for (let i = 0; i < 4; i++) part += alphabet[bytes[g * 4 + i] % alphabet.length];
      groups.push(part);
    }
    return 'aegis-' + groups.join('-');
  }

  function getStatus() {
    return {
      unlocked: Boolean(activeSession),
      isAndroid: IS_ANDROID,
      webCryptoNative: HAS_SUBTLE,
      cipher: 'AES-256-GCM',
      kdf: `PBKDF2-HMAC-SHA256 (${KDF_ITERATIONS.toLocaleString()} iterations)`,
      vaultIdShort: activeSession ? activeSession.vaultId.slice(0, 12) + '…' : null,
      keyFingerprint: activeSession ? activeSession.keyFingerprint : null
    };
  }

  window.AegisE2EE = {
    isUnlocked: () => Boolean(activeSession),
    isAndroid: IS_ANDROID,
    getStatus,
    unlockWithPassphrase,
    lockVault,
    generateStrongPassphrase,
    downloadDecrypted,
    getServerProof,
    createEncryptedShareLink,
    inspectIncomingShare,
    downloadIncomingShare,
    queueAndroidImport: (filename, mimeType, b64) => pendingAndroidImports.push({ filename, mimeType, b64 }),
    _selfTest: { PureCrypto, encryptBinaryEnvelope, decryptBinaryEnvelope, encryptJsonMeta, decryptJsonMeta }
  };
})();
