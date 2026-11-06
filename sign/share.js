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
/** 획 단순화(Ramer-Douglas-Peucker). 눈에 띄지 않는 점을 줄여 링크를 짧게 만든다. */
export function simplifyStrokes(strokes, eps = 1.4) {
  const rdp = pts => {
    if (pts.length < 3) return pts;
    const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1], len = Math.hypot(bx - ax, by - ay);
    let max = -1, idx = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = len ? Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len : Math.hypot(pts[i][0] - ax, pts[i][1] - ay);
      if (d > max) { max = d; idx = i; }
    }
    if (max <= eps) return [pts[0], pts[pts.length - 1]];
    return [...rdp(pts.slice(0, idx + 1)).slice(0, -1), ...rdp(pts.slice(idx))];
  };
  return strokes.map(rdp);
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

// ---- 링크용 압축 형식: 항목 이름 대신 위치로 저장, 날짜·시간은 숫자로, 지문은 앞 8자리만 ----
const DAY_ORDER = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const hhmm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const md = s => Number(s.slice(5, 7)) * 100 + Number(s.slice(8, 10));
const unmd = n => '2026-' + String(Math.floor(n / 100)).padStart(2, '0') + '-' + String(n % 100).padStart(2, '0');
export const termsToList = t => [t.businessName, t.ownerName, t.ownerPhone, t.workerName, t.workerPhone, t.workplaceScale === 'OVER_5' ? 1 : 0, t.contractType === 'DAILY' ? 1 : 0,
  md(t.startDate), md(t.endDate), t.workPlace, t.jobDescription, t.workDays.reduce((a, d) => a | (1 << DAY_ORDER.indexOf(d)), 0), toMin(t.startTime), toMin(t.endTime),
  t.breakMinutes, toMin(t.breakStartTime), t.hourlyWage, t.holidayPayIncluded ? 1 : 0, t.includedWage ?? 0, DAY_ORDER.indexOf(t.weeklyHoliday), t.payDay];
export const listToTerms = a => ({
  businessName: a[0], ownerName: a[1], ownerPhone: a[2], workerName: a[3], workerPhone: a[4], workplaceScale: a[5] ? 'OVER_5' : 'UNDER_5', contractType: a[6] ? 'DAILY' : 'PART_TIME',
  startDate: unmd(a[7]), endDate: unmd(a[8]), workPlace: a[9], jobDescription: a[10], workDays: DAY_ORDER.filter((_, i) => a[11] & (1 << i)), startTime: hhmm(a[12]), endTime: hhmm(a[13]),
  breakMinutes: a[14], breakStartTime: hhmm(a[15]), hourlyWage: a[16], holidayPayIncluded: !!a[17], includedWage: a[18] || null, weeklyHoliday: DAY_ORDER[a[19]], payDay: a[20],
});
const idToShort = id => id.slice(4), idFromShort = s => 'CNT-' + s;
const sec = iso => Date.parse(iso) / 1000, isoOf = s => new Date(s * 1000).toISOString();
/** rec(요청: id,terms,os,ot,fp / 완료: +ws,wt,hash) → 링크용 문자열. 무손실이 아니면 예전(긴) 형식으로 되돌린다. */
export async function encodeLink(kind, rec) {
  try {
    const done = kind === 'done', times = done ? [rec.ot, rec.wt] : [rec.ot];
    if (times.some(t => Date.parse(t) % 1000 !== 0)) throw new Error('legacy');
    const list = termsToList(rec.terms);
    if (canonicalJson(listToTerms(list)) !== canonicalJson(rec.terms)) throw new Error('legacy');
    const arr = done ? [2, 1, idToShort(rec.id), list, rec.os, sec(rec.ot), rec.ws, sec(rec.wt), rec.hash.slice(0, 8)] : [2, 0, idToShort(rec.id), list, rec.os, sec(rec.ot), rec.fp.slice(0, 8)];
    return await encodePayload(arr);
  } catch (e) {
    if (e.message !== 'legacy') throw e;
    return encodePayload({ k: kind === 'done' ? 'done' : 'req', ...rec });
  }
}
/** 링크 문자열 → 검증 전 원본 객체(예전 형식도 그대로 읽음). 압축 형식이면 chk에 지문 앞부분을 담는다. */
export async function decodeLink(str) {
  const p = await decodePayload(str);
  if (!Array.isArray(p)) return p;
  if (p[0] !== 2 || p.length < 7 || p.length > 9 || !Array.isArray(p[3]) || p[3].length !== 21 || typeof p[2] !== 'string' || !/^[0-9a-f]{12}$/.test(p[2])) throw new Error('링크 형식이 올바르지 않습니다.');
  try {
    const base = { id: idFromShort(p[2]), terms: listToTerms(p[3]), os: p[4], ot: isoOf(p[5]) };
    return p[1] === 1 ? { k: 'done', ...base, ws: p[6], wt: isoOf(p[7]), chk: p[8] } : { k: 'req', ...base, chk: p[6] };
  } catch { throw new Error('링크 내용을 읽을 수 없습니다.'); }
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
