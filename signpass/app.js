import { DAYS, DAY_LABELS, MIN_WAGE_2026, calculate, baseWageFromIncluded, validateTerms, suggestedBreak, minutesBetween, timeMinutes, toHHMM } from './calc.js';
import { encodePayload, decodePayload, packStrokes, checkPackedStrokes, fingerprint, SIG_W, SIG_H, hasInk } from './share.js';
import { renderDocument, esc, won, kst } from './doc.js';

const APP_VERSION = '2.1.0';
const KEY = 'signpass.contracts.v1';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const app = $('#app');
const baseUrl = () => location.href.split('#')[0];
const randomHex = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}
async function copyText(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg); return true; }
  catch { toast('자동 복사가 막혀 있습니다. 링크 칸을 길게 눌러 직접 복사하세요.'); return false; }
}

// ---------- 보관함(localStorage) ----------
const store = {
  all() { try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } },
  save(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch { toast('이 기기에 저장하지 못했습니다. 완료본을 PDF·링크로 따로 보관하세요.'); return false; } },
  upsert(entry) {
    const list = this.all().filter(e => e.id !== entry.id);
    list.unshift(entry);
    const ok = this.save(list); counter(); return ok;
  },
  remove(id) { this.save(this.all().filter(e => e.id !== id)); counter(); },
  find(id) { return this.all().find(e => e.id === id); },
};
function counter() { $('#cnt').textContent = store.all().length; }

// ---------- 검증: 링크·가져온 파일로 들어온 계약은 반드시 다시 확인 ----------
const iso = v => typeof v === 'string' && !isNaN(Date.parse(v)) && v.length <= 40;
const idOk = v => typeof v === 'string' && /^CNT-[0-9a-f]{12}$/.test(v);
const hex = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
async function verifyRequest(p) {
  if (!p || p.k !== 'req' || !idOk(p.id) || !iso(p.ot) || !hex(p.fp)) return { error: '서명 요청 링크가 올바르지 않습니다.' };
  const errs = validateTerms(p.terms); if (errs.length) return { error: '계약 내용에 문제가 있습니다: ' + errs[0] };
  const o = checkPackedStrokes(p.os); if (!o) return { error: '사업주 서명을 확인할 수 없습니다.' };
  const fp = await fingerprint({ id: p.id, terms: p.terms, os: p.os, ot: p.ot });
  if (fp !== p.fp) return { error: '링크가 잘렸거나 내용이 바뀌었습니다. 사업주에게 링크를 다시 받으세요.' };
  return { rec: { id: p.id, terms: p.terms, os: p.os, ot: p.ot, fp: p.fp }, ownerStrokes: o };
}
async function verifyDone(p) {
  if (!p || p.k !== 'done' || !idOk(p.id) || !iso(p.ot) || !iso(p.wt) || !hex(p.hash)) return { error: '서명 완료 링크가 올바르지 않습니다.' };
  const errs = validateTerms(p.terms); if (errs.length) return { error: '계약 내용에 문제가 있습니다: ' + errs[0] };
  const o = checkPackedStrokes(p.os), w = checkPackedStrokes(p.ws);
  if (!o || !w) return { error: '서명을 확인할 수 없습니다.' };
  const h = await fingerprint({ id: p.id, terms: p.terms, os: p.os, ot: p.ot, ws: p.ws, wt: p.wt });
  if (h !== p.hash) return { error: '계약 지문이 일치하지 않습니다. 내용이 바뀌었거나 링크가 훼손되었습니다.' };
  return { rec: { id: p.id, terms: p.terms, os: p.os, ot: p.ot, ws: p.ws, wt: p.wt, hash: p.hash }, ownerStrokes: o, workerStrokes: w };
}

// ---------- 서명 패드 ----------
function makePad(canvas, onChange) {
  canvas.width = SIG_W * 2; canvas.height = SIG_H * 2;
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#172238';
  let strokes = [], cur = null;
  const pt = e => { const r = canvas.getBoundingClientRect(); return [Math.min(SIG_W, Math.max(0, Math.round((e.clientX - r.left) * SIG_W / r.width))), Math.min(SIG_H, Math.max(0, Math.round((e.clientY - r.top) * SIG_H / r.height)))]; };
  canvas.addEventListener('pointerdown', e => { e.preventDefault(); canvas.setPointerCapture(e.pointerId); cur = [pt(e)]; strokes.push(cur); ctx.beginPath(); ctx.moveTo(cur[0][0] * 2, cur[0][1] * 2); ctx.lineTo(cur[0][0] * 2 + .1, cur[0][1] * 2); ctx.stroke(); });
  canvas.addEventListener('pointermove', e => {
    if (!cur) return;
    const p = pt(e), l = cur[cur.length - 1];
    if (Math.abs(p[0] - l[0]) + Math.abs(p[1] - l[1]) < 3) return; // 점을 줄여 링크를 짧게 유지
    cur.push(p); ctx.lineTo(p[0] * 2, p[1] * 2); ctx.stroke();
  });
  const end = () => { if (cur) { cur = null; onChange(strokes); } };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  return { get strokes() { return strokes; }, clear() { strokes = []; cur = null; ctx.clearRect(0, 0, canvas.width, canvas.height); onChange(strokes); } };
}
const padHtml = (id, label) => `<canvas class="pad" id="${id}" aria-label="${label}"></canvas><div class="actions"><button type="button" class="secondary" data-clear="${id}">서명 지우기</button></div>`;

// ---------- 화면: 작성 ----------
const FIELDS = ['businessName', 'ownerName', 'ownerPhone', 'workerName', 'workerPhone', 'workPlace', 'jobDescription', 'startDate', 'endDate', 'startTime', 'endTime', 'breakStartTime', 'payDay'];
const today = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); const s = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; return s.startsWith('2026-') ? s : '2026-01-01'; };
const field = (name, label, type = 'text', extra = '') => `<label>${label}<input name="${name}" type="${type}" ${extra}></label>`;

function renderCreate(prefill) {
  app.innerHTML = `<form id="f" class="stack" novalidate>
<section class="card stack"><h1>근로계약서 작성</h1>
<p class="muted">사장님이 조건을 입력하고 서명 → 링크를 근로자에게 전달 → 근로자가 휴대폰에서 서명합니다. 성인 근로자, 요일별 같은 일정, 하루 8시간·주 40시간 이내를 지원합니다.</p>
<h2>1. 사업주와 근로자</h2>
<div class="grid">${field('businessName', '상호명', 'text', 'maxlength="100" autocomplete="organization"')}${field('ownerName', '대표자 성명', 'text', 'maxlength="50"')}${field('ownerPhone', '사업주 연락처', 'tel', 'inputmode="tel"')}${field('workerName', '근로자 성명', 'text', 'maxlength="50"')}${field('workerPhone', '근로자 연락처', 'tel', 'inputmode="tel"')}</div>
<label>상시 근로자 규모<select name="workplaceScale"><option value="UNDER_5">5인 미만 (야간가산 없음)</option><option value="OVER_5">5인 이상 (22~06시 50% 가산)</option></select></label>
<h2>2. 계약기간과 업무</h2>
<label>계약 유형<select name="contractType"><option value="PART_TIME">기간제 단시간</option><option value="DAILY">일용 (하루)</option></select></label>
<div class="grid">${field('startDate', '시작일', 'date', 'min="2026-01-01" max="2026-12-31"')}${field('endDate', '종료일', 'date', 'min="2026-01-01" max="2026-12-31"')}</div>
${field('workPlace', '근무장소', 'text', 'maxlength="200"')}${field('jobDescription', '업무내용', 'text', 'maxlength="500"')}
<h2>3. 근무 일정</h2>
<div class="days" role="group" aria-label="근무 요일">${DAYS.map(d => `<button type="button" data-day="${d}" aria-pressed="false">${DAY_LABELS[d]}</button>`).join('')}</div>
<div class="grid">${field('startTime', '출근 시간', 'time')}${field('endTime', '퇴근 시간', 'time')}${field('breakStartTime', '휴게 시작', 'time')}${field('breakMinutes', '휴게시간 (분)', 'number', 'min="0" max="240" step="1" inputmode="numeric"')}</div>
<p class="muted small">시간을 바꾸면 휴게를 임시로 배치합니다. 실제 쉬는 시간으로 수정하세요. 퇴근이 출근보다 이르면 익일입니다. 4시간 이상 30분, 8시간 1시간 휴게가 필요합니다.</p>
<label>지정 주휴일<select name="weeklyHoliday">${DAYS.map(d => `<option value="${d}">${DAY_LABELS[d]}요일</option>`).join('')}</select></label>
<h2>4. 임금 <span class="muted small">2026 최저시급 10,320원</span></h2>
<label>주휴수당 표기 방식<select name="payMode"><option value="SEPARATE">시급 외 별도 지급 (기본시급 입력)</option><option value="INCLUDED">주휴수당 포함 시급 입력 (기본시급 자동 분리)</option></select></label>
<label id="wageSep">기본시급 (원)<input name="hourlyWage" type="number" min="10320" max="1000000" step="1" inputmode="numeric"></label>
<label id="wageInc" hidden>주휴수당 포함 시급 (원)<input name="includedWage" type="number" min="1" max="2000000" step="1" inputmode="numeric"></label>
<div class="actions"><button type="button" class="secondary" id="minWage">2026 최저시급 적용</button></div>
${field('payDay', '임금 지급일', 'text', 'maxlength="80"')}
</section>
<section class="card est" aria-live="polite"><h2 style="margin-top:0">예상 근로조건</h2><div id="est"></div></section>
<section class="card stack"><h2 style="margin-top:0">5. 사업주 서명</h2><p class="muted small">아래에 손가락이나 마우스로 서명하세요. 서명한 뒤에는 근로자에게 보낼 링크가 만들어집니다.</p>${padHtml('ownerPad', '사업주 서명 영역')}
<label class="check"><input type="checkbox" id="adult"><span>성인 근로자이며 이 버전의 근무조건 지원 범위를 확인했습니다.</span></label>
<label class="check"><input type="checkbox" id="agree"><span>사업주로서 위 조건에 동의하고 계약서 작성 및 전자문서 교부를 진행합니다.</span></label>
<div id="err" role="alert"></div>
<button type="submit" id="submitBtn">서명하고 근로자에게 보낼 링크 만들기</button></section>
</form>`;
  const f = $('#f');
  const set = (n, v) => { f.elements[n].value = v ?? ''; };
  const p = prefill || {};
  const startTime = p.startTime || '09:00', endTime = p.endTime || '18:00';
  FIELDS.forEach(n => set(n, p[n] ?? ''));
  set('businessName', p.businessName); set('startTime', startTime); set('endTime', endTime);
  set('startDate', p.startDate || today()); set('endDate', p.endDate || '2026-12-31');
  set('jobDescription', p.jobDescription || '매장 관리 및 홀 보조'); set('payDay', p.payDay || '매월 10일');
  set('breakMinutes', p.breakMinutes ?? 60); set('breakStartTime', p.breakStartTime || '12:00');
  set('workplaceScale', p.workplaceScale || 'UNDER_5'); set('contractType', p.contractType || 'PART_TIME'); set('weeklyHoliday', p.weeklyHoliday || 'SUN');
  set('payMode', p.holidayPayIncluded ? 'INCLUDED' : 'SEPARATE');
  set('hourlyWage', p.hourlyWage ?? MIN_WAGE_2026);
  set('includedWage', p.includedWage ?? 12384);
  const days = new Set(p.workDays || ['MON', 'WED', 'FRI']);
  $$('[data-day]', f).forEach(b => b.setAttribute('aria-pressed', String(days.has(b.dataset.day))));
  const pad = makePad($('#ownerPad'), () => {});
  $$('[data-clear]').forEach(b => b.addEventListener('click', () => pad.clear()));

  const val = n => f.elements[n].value.trim();
  const num = n => (val(n) === '' ? NaN : Number(val(n)));
  function readTerms() {
    const daily = val('contractType') === 'DAILY';
    const sd = val('startDate');
    let workDays = $$('[data-day]', f).filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.day);
    if (daily && /^\d{4}-\d{2}-\d{2}$/.test(sd)) workDays = [DAYS[(new Date(sd + 'T00:00:00Z').getUTCDay() + 6) % 7]];
    const included = val('payMode') === 'INCLUDED';
    const t = {
      businessName: val('businessName'), ownerName: val('ownerName'), ownerPhone: val('ownerPhone'), workerName: val('workerName'), workerPhone: val('workerPhone'),
      workplaceScale: val('workplaceScale'), contractType: val('contractType'), startDate: sd, endDate: daily ? sd : val('endDate'),
      workPlace: val('workPlace'), jobDescription: val('jobDescription'), workDays, startTime: val('startTime'), endTime: val('endTime'),
      breakMinutes: num('breakMinutes'), breakStartTime: val('breakStartTime'), hourlyWage: num('hourlyWage'), holidayPayIncluded: included,
      includedWage: included ? num('includedWage') : null, weeklyHoliday: val('weeklyHoliday'), payDay: val('payDay'),
    };
    return t;
  }
  let derivedError = '';
  function derive(t) {
    derivedError = '';
    if (!t.holidayPayIncluded) return t;
    try { return { ...t, hourlyWage: baseWageFromIncluded(t.includedWage, t) }; }
    catch (e) { derivedError = e.message; return { ...t, hourlyWage: NaN }; }
  }
  function refresh() {
    const daily = val('contractType') === 'DAILY';
    f.elements.endDate.disabled = daily; if (daily) f.elements.endDate.value = val('startDate');
    $$('[data-day]', f).forEach(b => { b.disabled = daily; });
    if (daily && /^\d{4}-\d{2}-\d{2}$/.test(val('startDate'))) { const d = DAYS[(new Date(val('startDate') + 'T00:00:00Z').getUTCDay() + 6) % 7]; $$('[data-day]', f).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.day === d))); }
    const inc = val('payMode') === 'INCLUDED';
    $('#wageSep').hidden = inc; $('#wageInc').hidden = !inc;
    const t = derive(readTerms());
    let html = '';
    try {
      if (derivedError) throw new Error(derivedError);
      const r = calculate(t);
      if (inc) html += `<p class="note" id="incNote">기본시급 ${won(t.hourlyWage)} + 주휴수당분 ${won(Math.max(0, t.includedWage - t.hourlyWage))} (주 소정근로 ${r.weeklyNetHours.toFixed(2)}시간 기준 주휴 ${r.weeklyHolidayHours.toFixed(2)}시간 합산) — 기본시급은 최저임금 10,320원 이상이어야 합니다.</p>`;
      html += `<p class="big">월 환산 예상 ${t.contractType === 'DAILY' ? won(Math.round(r.dailyNetMinutes * t.hourlyWage / 60) + r.nightPerDay) + ' (당일)' : won(r.monthlySalary)}</p>`;
      html += `<p>실근로: 일 ${r.dailyNetHours.toFixed(2)}시간 / 주 ${r.weeklyNetHours.toFixed(2)}시간</p><p>주휴 예상액: ${won(r.weeklyHolidayPay)} / 포함 환산시급 ${won(r.effectiveWageWithHoliday)}</p><p>야간: 일 ${r.nightMinutesPerDay}분 / 가산 ${won(r.nightPerDay)}</p>`;
      html += r.advice.map(a => `<p class="muted small">${esc(a)}</p>`).join('');
    } catch (e) { html = `<p class="warn">${esc(e.message)}</p>`; }
    $('#est').innerHTML = html;
  }
  function autoBreak() {
    try {
      const gross = minutesBetween(val('startTime'), val('endTime')), rest = suggestedBreak(gross);
      set('breakMinutes', rest); set('breakStartTime', toHHMM(timeMinutes(val('startTime')) + Math.floor((gross - rest) / 2)));
    } catch { /* 입력 중 */ }
  }
  f.addEventListener('input', e => { if (e.target.name === 'startTime' || e.target.name === 'endTime') autoBreak(); refresh(); });
  f.addEventListener('change', refresh);
  f.addEventListener('click', e => {
    const b = e.target.closest('[data-day]'); if (b && !b.disabled) { b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')); refresh(); }
    if (e.target.id === 'minWage') { if (val('payMode') === 'INCLUDED') { try { const t = readTerms(); const r = calculate({ ...t, hourlyWage: 0 }); set('includedWage', Math.ceil(MIN_WAGE_2026 * (1 + r.weeklyHolidayMinutes / r.weeklyNetMinutes) - 1e-9)); } catch { set('includedWage', MIN_WAGE_2026); } } else set('hourlyWage', MIN_WAGE_2026); refresh(); }
  });
  refresh();

  f.addEventListener('submit', async e => {
    e.preventDefault();
    const errs = [];
    const t = derive(readTerms());
    if (derivedError) errs.push(derivedError); else errs.push(...validateTerms(t));
    if (!hasInk(pad.strokes)) errs.push('사업주 서명란에 서명해 주세요.');
    if (!$('#adult').checked) errs.push('성인 근로자 확인란에 체크해 주세요.');
    if (!$('#agree').checked) errs.push('사업주 동의란에 체크해 주세요.');
    const box = $('#err');
    if (errs.length) { box.className = 'error'; box.innerHTML = '<ul>' + errs.map(m => `<li>${esc(m)}</li>`).join('') + '</ul>'; box.scrollIntoView({ block: 'center' }); return; }
    box.className = ''; box.innerHTML = '';
    $('#submitBtn').disabled = true;
    try {
      const core = { id: 'CNT-' + randomHex(6), terms: t, os: packStrokes(pad.strokes), ot: new Date().toISOString() };
      const rec = { ...core, fp: await fingerprint(core) };
      store.upsert({ id: rec.id, status: 'PENDING', rec, savedAt: new Date().toISOString() });
      await renderShare(rec);
    } finally { const b = $('#submitBtn'); if (b) b.disabled = false; } // 성공 시 화면이 바뀌어 버튼이 없을 수 있음
  });
}

// ---------- 화면: 링크 전달 ----------
async function requestLink(rec) { return baseUrl() + '#s=' + await encodePayload({ k: 'req', ...rec }); }
async function renderShare(rec) {
  const link = await requestLink(rec), t = rec.terms;
  app.innerHTML = `<section class="card stack"><h1>사업주 서명이 완료되었습니다</h1>
<p class="note">아래 링크를 <strong>${esc(t.workerName)}</strong> 님에게 카카오톡·문자로 보내세요. 근로자는 설치나 가입 없이 휴대폰에서 열어 내용을 확인하고 서명합니다.</p>
<textarea class="link" id="link" readonly aria-label="서명 요청 링크">${esc(link)}</textarea>
<div class="actions"><button type="button" id="copy">서명 요청 링크 복사</button>${navigator.share ? '<button type="button" class="secondary" id="share">카카오톡·문자로 공유</button>' : ''}<button type="button" class="secondary" id="local">이 기기에서 바로 근로자 서명</button></div>
<p class="warn">링크를 가진 사람은 누구나 이 계약에 서명할 수 있습니다. 본인인증은 하지 않으니 근로자에게만 보내세요. 링크 길이: ${link.length.toLocaleString()}자</p>
<p class="muted small">서명이 끝나면 근로자 기기에서 <strong>서명 완료본 링크</strong>와 PDF가 만들어지고, 사장님께 보내면 이 기기의 보관함에 저장됩니다. 이 계약은 보관함에 "서명 대기"로 저장되어 있습니다.</p>
</section><div class="actions"><button type="button" class="secondary" data-nav="archive">보관함 보기</button><button type="button" class="secondary" data-nav="create">새 계약 작성</button></div>`;
  $('#copy').onclick = () => copyText(link, '링크를 복사했습니다. 카카오톡에 붙여넣어 보내세요.');
  $('#share')?.addEventListener('click', async () => { try { await navigator.share({ title: `[${t.businessName}] 근로계약서 서명 요청`, text: `${t.ownerName} 대표님이 근로계약서 서명을 요청했습니다. 링크를 눌러 확인하고 서명해 주세요.`, url: link }); } catch { /* 취소 */ } });
  $('#local').onclick = () => renderSign(rec, true);
}

// ---------- 화면: 근로자 서명 ----------
async function renderSign(rec, local = false) {
  const o = checkPackedStrokes(rec.os);
  app.innerHTML = `<section class="card stack"><h1>${esc(rec.terms.workerName)} 님, 계약서를 확인하고 서명하세요</h1>
<p class="muted">${esc(rec.terms.ownerName)} 대표님이 이미 서명한 계약서입니다. 아래 내용을 끝까지 읽어 보세요.</p></section>
<section class="card">${renderDocument({ id: rec.id, terms: rec.terms, ownerStrokes: o, ot: rec.ot })}</section>
<section class="card stack"><h2 style="margin-top:0">근로자 서명</h2>${padHtml('workerPad', '근로자 서명 영역')}
<label class="check"><input type="checkbox" id="consent"><span>근로조건을 모두 확인했으며, 전자서명과 서명 완료본 수령에 동의합니다.</span></label>
<div id="err" role="alert"></div><button type="button" id="signBtn" disabled>동의하고 서명 완료</button>
${local ? '' : '<p class="muted small">이 계약서는 링크에 담긴 내용 그대로입니다. 서버에 저장되지 않습니다.</p>'}</section>`;
  const sync = () => { $('#signBtn').disabled = !($('#consent').checked && hasInk(pad.strokes)); };
  const pad = makePad($('#workerPad'), sync);
  $$('[data-clear]').forEach(b => b.addEventListener('click', () => pad.clear()));
  $('#consent').onchange = sync;
  $('#signBtn').onclick = async () => {
    $('#signBtn').disabled = true;
    const core = { id: rec.id, terms: rec.terms, os: rec.os, ot: rec.ot, ws: packStrokes(pad.strokes), wt: new Date().toISOString() };
    const done = { ...core, hash: await fingerprint(core) };
    store.upsert({ id: done.id, status: 'SIGNED', rec: done, savedAt: new Date().toISOString() });
    await renderDone(done, local ? 'owner-device' : 'worker');
  };
}

// ---------- 화면: 완료 ----------
const safeName = r => `${r.terms.workerName}_근로계약서_${r.terms.businessName}`.replace(/[\\/:*?"<>|\s]+/g, '_');
function pdfJob(rec) {
  return window.html2pdf().set({ margin: [10, 10, 10, 10], filename: safeName(rec) + '.pdf', image: { type: 'jpeg', quality: 0.95 },
    html2canvas: { scale: 2, backgroundColor: '#ffffff' }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }, pagebreak: { mode: ['css', 'legacy'] } }).from($('#doc'));
}
async function renderDone(rec, who) {
  const v = await verifyDone({ k: 'done', ...rec });
  if (v.error) return renderError(v.error);
  const link = baseUrl() + '#d=' + await encodePayload({ k: 'done', ...rec });
  const toOwner = who === 'worker';
  app.innerHTML = `<section class="card stack"><h1>서명이 완료되었습니다</h1>
<p class="note">양측 서명이 끝났고 계약 지문이 일치합니다. 이 기기 보관함에도 저장했습니다.</p>
<div class="actions noprint"><button type="button" id="pdf">PDF 저장</button>
<button type="button" class="secondary" id="sendDone">${toOwner ? '사장님께 서명 완료본 보내기' : '근로자에게 서명 완료본 보내기'}</button>
<button type="button" class="secondary" id="copyDone">완료본 링크 복사</button></div>
${toOwner ? '<p class="warn">사장님이 이 계약을 보관함에 저장하려면 <strong>서명 완료본 링크</strong>를 사장님께 보내야 합니다. PDF만 보내도 계약서 자체는 전달됩니다.</p>' : ''}
<p class="muted small noprint">계약 지문: <span class="break">${esc(rec.hash)}</span></p></section>
<section class="card">${renderDocument({ id: rec.id, terms: rec.terms, ownerStrokes: v.ownerStrokes, workerStrokes: v.workerStrokes, ot: rec.ot, wt: rec.wt, hash: rec.hash })}</section>
<div class="actions noprint"><button type="button" class="secondary" data-nav="archive">보관함 보기</button><button type="button" class="secondary" data-nav="create">새 계약 작성</button></div>`;
  $('#pdf').onclick = async () => {
    if (!window.html2pdf) { toast('PDF 도구를 불러오지 못해 인쇄 화면을 엽니다. "PDF로 저장"을 선택하세요.'); window.print(); return; }
    toast('PDF를 만드는 중입니다…');
    try { await pdfJob(rec).save(); toast('PDF를 저장했습니다.'); } catch { toast('PDF 생성에 실패해 인쇄 화면을 엽니다.'); window.print(); }
  };
  $('#copyDone').onclick = () => copyText(link, '서명 완료본 링크를 복사했습니다.');
  $('#sendDone').onclick = async () => {
    const text = `[${rec.terms.businessName}] 근로계약서 서명 완료본입니다. 링크를 열면 내용 확인과 보관함 저장이 됩니다.`;
    try {
      if (window.html2pdf && navigator.canShare) {
        const blob = await pdfJob(rec).outputPdf('blob'), file = new File([blob], safeName(rec) + '.pdf', { type: 'application/pdf' });
        if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: '근로계약서 서명 완료본', text: text + '\n' + link }); return; }
      }
      if (navigator.share) await navigator.share({ title: '근로계약서 서명 완료본', text, url: link });
      else await copyText(link, '공유 기능이 없어 링크를 복사했습니다. 카카오톡에 붙여넣으세요.');
    } catch { /* 취소 */ }
  };
}

function renderError(msg) {
  app.innerHTML = `<section class="card stack"><h1>계약서를 열 수 없습니다</h1><p class="error">${esc(msg)}</p><button type="button" data-nav="create">새 계약 작성</button></section>`;
}

// ---------- 화면: 보관함 ----------
async function renderArchive() {
  const list = store.all();
  app.innerHTML = `<section class="card stack"><h1>계약서 보관함</h1>
<p class="muted small">이 기기의 브라우저에만 저장됩니다. 기기를 바꾸거나 브라우저 데이터를 지우면 사라지므로 <strong>백업 파일</strong>을 가끔 내보내 두세요.</p>
<div class="actions"><button type="button" class="secondary" id="exp" ${list.length ? '' : 'disabled'}>백업 파일 내보내기</button><label class="btn secondary" style="font-weight:700">백업 파일 가져오기<input type="file" id="imp" accept="application/json,.json" hidden></label></div></section>
<div id="rows">${list.length ? '' : '<p class="muted">저장된 계약이 없습니다.</p>'}</div>`;
  const rows = $('#rows');
  for (const e of list) {
    const t = e.rec?.terms; if (!t) continue;
    let est = ''; try { est = won(calculate(t).monthlySalary); } catch { est = '-'; }
    const signed = e.status === 'SIGNED';
    const el = document.createElement('section'); el.className = 'card stack';
    el.innerHTML = `<div class="row"><h2 style="margin:0">${esc(t.workerName)}</h2><span class="tag ${signed ? 'ok' : 'wait'}">${signed ? '서명 완료' : '근로자 서명 대기'}</span></div>
<p>${esc(t.businessName)} / ${esc(t.startDate)} ~ ${esc(t.endDate)}<br>기본시급 ${won(t.hourlyWage)} · 월 환산 예상 ${est}</p>
${signed ? `<p class="muted small break">계약 지문: ${esc(e.rec.hash)}</p>` : ''}
<div class="actions"><button type="button" data-open="${esc(e.id)}">${signed ? '열기·PDF' : '링크 다시 보기'}</button><button type="button" class="secondary" data-renew="${esc(e.id)}">조건 복사해 재계약</button><button type="button" class="danger" data-del="${esc(e.id)}">삭제</button></div>`;
    rows.append(el);
  }
  rows.onclick = async ev => {
    const b = ev.target.closest('button'); if (!b) return;
    const id = b.dataset.open || b.dataset.renew || b.dataset.del, e = store.find(id); if (!e) return;
    if (b.dataset.open) e.status === 'SIGNED' ? renderDone(e.rec, 'owner-device') : renderShare(e.rec);
    if (b.dataset.renew) { history.replaceState(null, '', baseUrl()); renderCreate({ ...e.rec.terms, startDate: today(), endDate: '2026-12-31' }); window.scrollTo(0, 0); toast('이전 조건을 불러왔습니다. 날짜와 서명을 새로 입력하세요.'); }
    if (b.dataset.del && confirm('이 기기에서 삭제할까요? 백업이나 PDF가 없으면 복구할 수 없습니다.')) { store.remove(id); renderArchive(); }
  };
  $('#exp').onclick = () => {
    const blob = new Blob([JSON.stringify({ app: 'signpass', version: APP_VERSION, exportedAt: new Date().toISOString(), contracts: store.all() })], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `signpass-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('#imp').onchange = async ev => {
    const file = ev.target.files[0]; if (!file) return;
    try {
      if (file.size > 20e6) throw new Error('파일이 너무 큽니다.');
      const data = JSON.parse(await file.text()); let ok = 0, bad = 0;
      for (const e of Array.isArray(data.contracts) ? data.contracts : []) {
        const v = e?.status === 'SIGNED' ? await verifyDone({ k: 'done', ...e.rec }) : await verifyRequest({ k: 'req', ...e.rec });
        if (v.error) { bad++; continue; }
        const cur = store.find(e.rec.id); if (cur?.status === 'SIGNED' && e.status !== 'SIGNED') continue;
        store.upsert({ id: e.rec.id, status: e.status === 'SIGNED' ? 'SIGNED' : 'PENDING', rec: v.rec, savedAt: iso(e.savedAt) ? e.savedAt : new Date().toISOString() }); ok++;
      }
      toast(`가져오기 완료: ${ok}건${bad ? `, 검증 실패 ${bad}건 제외` : ''}`); renderArchive();
    } catch (err) { toast('백업 파일을 읽지 못했습니다: ' + err.message); }
  };
}

// ---------- 라우팅 ----------
async function route() {
  window.scrollTo(0, 0);
  const h = location.hash;
  const m = /^#([sd])=(.+)$/.exec(h);
  $('#nav').hidden = !!m && m[1] === 's';
  if (!m) { renderCreate(); return; }
  let payload;
  try { payload = await decodePayload(m[2]); } catch (e) { return renderError(e.message); }
  if (m[1] === 's') {
    const v = await verifyRequest(payload);
    if (v.error) return renderError(v.error);
    const saved = store.find(v.rec.id);
    if (saved?.status === 'SIGNED') return renderDone(saved.rec, 'worker'); // 이미 이 기기에서 서명함
    return renderSign(v.rec);
  }
  const v = await verifyDone(payload);
  if (v.error) return renderError(v.error);
  const had = store.find(v.rec.id)?.status === 'SIGNED';
  store.upsert({ id: v.rec.id, status: 'SIGNED', rec: v.rec, savedAt: new Date().toISOString() });
  await renderDone(v.rec, 'owner-device');
  if (!had) toast('서명 완료본을 이 기기 보관함에 저장했습니다.');
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-nav]'); if (!b) return;
  if (location.hash) history.replaceState(null, '', baseUrl());
  $('#nav').hidden = false;
  b.dataset.nav === 'archive' ? renderArchive() : renderCreate();
  window.scrollTo(0, 0);
});
window.addEventListener('hashchange', route);
counter();
route();
