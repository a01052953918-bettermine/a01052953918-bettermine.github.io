// 링크에 계약 내용을 담는 인코딩(deflate + base64url), 서명 획 처리, SHA-256 계약 지문.
const MAX_DECODED_BYTES = 200000;

function toB64u(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64u(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]+$/.test(str)) throw new Error('링크 형식이 올바르지 않습니다.');
  const b = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}
export async function encodePayload(obj) {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return toB64u(new Uint8Array(await new Response(stream).arrayBuffer()));
}
export async function decodePayload(str) {
  const raw = fromB64u(str);
  const reader = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_DECODED_BYTES) { await reader.cancel(); throw new Error('링크 내용이 너무 큽니다.'); }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all)); }
  catch { throw new Error('링크 내용을 읽을 수 없습니다. 링크가 잘렸을 수 있습니다.'); }
}

// ---- 서명 획: 좌표 격자 500x175, 첫 점 절대좌표 + 이후 변화량(작게 압축하기 위함) ----
export const SIG_W = 500, SIG_H = 175;
export function packStrokes(strokes) {
  return strokes.map(pts => {
    const out = [];
    let px = 0, py = 0;
    pts.forEach(([x, y], i) => { out.push(i ? x - px : x, i ? y - py : y); px = x; py = y; });
    return out;
  });
}
export function unpackStrokes(packed) {
  return packed.map(flat => {
    const pts = [];
    let x = 0, y = 0;
    for (let i = 0; i < flat.length; i += 2) { x = i ? x + flat[i] : flat[i]; y = i ? y + flat[i + 1] : flat[i + 1]; pts.push([x, y]); }
    return pts;
  });
}
/** 외부(링크)에서 온 서명 데이터 검증. 올바르면 점 배열 목록을 반환, 아니면 null */
export function checkPackedStrokes(packed) {
  if (!Array.isArray(packed) || !packed.length || packed.length > 40) return null;
  let total = 0;
  for (const f of packed) {
    if (!Array.isArray(f) || f.length < 2 || f.length % 2 || !f.every(n => Number.isInteger(n) && Math.abs(n) <= 1000)) return null;
    total += f.length / 2;
    if (total > 3000) return null;
  }
  const strokes = unpackStrokes(packed);
  if (!strokes.every(s => s.every(([x, y]) => x >= 0 && x <= SIG_W && y >= 0 && y <= SIG_H))) return null;
  return hasInk(strokes) ? strokes : null;
}
export function hasInk(strokes) {
  const pts = strokes.flat();
  if (pts.length < 8) return false;
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return Math.max(...xs) - Math.min(...xs) >= 30 || Math.max(...ys) - Math.min(...ys) >= 20;
}
export function strokesToSvg(strokes, label) {
  const paths = strokes.map(pts => {
    const d = pts.length === 1 ? `M${pts[0][0]} ${pts[0][1]}h0.1` : 'M' + pts.map(p => p.join(' ')).join('L');
    return `<path d="${d}"/>`;
  }).join('');
  return `<svg class="sig" viewBox="0 0 ${SIG_W} ${SIG_H}" role="img" aria-label="${label}" fill="none" stroke="#172238" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

// ---- 계약 지문(SHA-256) ----
export function canonicalJson(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
}
export const fingerprint = obj => sha256Hex(canonicalJson(obj));
