import { calculate, DAY_LABELS, timeMinutes, toHHMM } from './calc.js';
import { strokesToSvg } from './share.js';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const phone = s => String(s).replace(/^(0\d{1,2})(\d{3,4})(\d{4})$/, '$1-$2-$3'); // 표시용: 010-1234-5678
const won = n => Number(n).toLocaleString('ko-KR') + '원';
const kst = iso => new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false }) + ' (한국시간)';

/** 모든 사용자 입력은 esc()로 처리한다. 링크로 들어온 내용이 화면에 스크립트를 심지 못하게 하기 위함. */
export function renderDocument({ id, terms: t, ownerStrokes, workerStrokes, ot, wt, hash }) {
  const r = calculate(t);
  const breakEnd = toHHMM(timeMinutes(t.breakStartTime || '00:00') + t.breakMinutes);
  const overnight = timeMinutes(t.endTime) < timeMinutes(t.startTime) ? ' (익일 퇴근)' : '';
  const wageLine = t.holidayPayIncluded
    ? `주휴수당 포함 시급 <strong>${won(t.includedWage ?? r.effectiveWageWithHoliday)}</strong> = 기본시급 ${won(t.hourlyWage)} + 주휴수당분 (요건 충족 시)`
    : `기본시급 <strong>${won(t.hourlyWage)}</strong> (주휴수당은 요건 충족 시 별도 지급)`;
  return `<article class="paper" id="doc">
<h1>단기·단시간 근로계약서</h1>
<p><strong>${esc(t.businessName)}</strong>의 대표자 <strong>${esc(t.ownerName)}</strong>(사업주)와 <strong>${esc(t.workerName)}</strong>(근로자)는 아래 조건에 합의합니다.</p>
<h2>1. 계약기간 및 업무</h2>
<p>계약기간: ${esc(t.startDate)} ~ ${esc(t.endDate)} / ${t.contractType === 'DAILY' ? '일용' : '기간제 단시간'}<br>근무장소: ${esc(t.workPlace)}<br>업무내용: ${esc(t.jobDescription)}</p>
<h2>2. 근로일·근로시간·휴게</h2>
<p>매주 ${t.workDays.map(d => DAY_LABELS[d]).join(', ')}요일 / ${esc(t.startTime)} ~ ${esc(t.endTime)}${overnight}<br>
휴게: ${t.breakMinutes ? `${esc(t.breakStartTime)} ~ ${breakEnd} (${t.breakMinutes}분)` : '없음'}<br>
실근로: 1일 ${r.dailyNetHours.toFixed(2)}시간 / 주 ${r.weeklyNetHours.toFixed(2)}시간</p>
<p>휴게는 근무 도중 근로자가 자유롭게 이용하며 근로시간에 포함하지 않습니다. 대기·업무 지시를 받는 시간은 휴게로 공제하지 않습니다.</p>
<h2>3. 임금과 지급</h2>
<p>${wageLine}<br>
주휴 예상액: 주 ${won(r.weeklyHolidayPay)} / 환산시급 ${won(r.effectiveWageWithHoliday)}<br>
야간 실근로: 1일 ${r.nightMinutesPerDay}분 / 야간 가산 예상액: 일 ${won(r.nightPerDay)}<br>
임금 지급일: ${esc(t.payDay)} / 지급방법: 근로자 명의 계좌 입금</p>
<p>사업장 규모: ${t.workplaceScale === 'OVER_5' ? '상시 5인 이상 (야간근로 통상임금 50% 가산)' : '상시 5인 미만 (법정 야간가산 미적용)'}.
계산은 기본시급을 통상시급으로 가정합니다. 다른 고정수당이 있으면 별도 검토가 필요합니다. 실제 임금은 출근기록·유급휴일 등을 반영해 정산하며 임금명세서에 항목을 구분합니다. 주휴 포함 표기는 주휴수당을 이중으로 지급한다는 뜻이 아닙니다.</p>
<h2>4. 휴일·휴가 및 추가 근로</h2>
<p>지정 주휴일: 매주 ${DAY_LABELS[t.weeklyHoliday]}요일. 주휴는 4주 평균 주 소정근로시간 15시간 이상, 개근 및 근로관계 유지 등 요건에 따라 부여합니다.
토·일 근무만으로 휴일가산 여부를 판단하지 않으며, 법정·약정 휴일과 겹치면 별도 적용합니다. 연차유급휴가 및 공휴일은 사업장 규모와 소정근로시간 등 관련 법령의 적용요건에 따릅니다. 소정근로시간을 넘는 추가 근로는 별도 동의 및 관련 법령의 가산 지급 여부를 확인합니다.</p>
<h2>5. 계약서 교부 및 기타</h2>
<p>사업주는 서명 완료본을 근로자가 내려받아 보관할 수 있도록 교부하고 전달 여부를 확인합니다. 명시하지 않은 사항은 관계 법령과 적법한 취업규칙에 따릅니다. 이 문서는 정부 인증 서식 또는 공인 전자서명 인증서가 아닙니다.</p>
<div class="signatures">
<section><h2>사업주</h2><p>${esc(t.businessName)}<br>${esc(t.ownerName)} / ${esc(phone(t.ownerPhone))}</p>${ownerStrokes ? strokesToSvg(ownerStrokes, '사업주 서명') : '<p class="muted">서명 대기</p>'}${ot ? `<p class="muted">서명 시각 ${kst(ot)}</p>` : ''}</section>
<section><h2>근로자</h2><p>${esc(t.workerName)} / ${esc(phone(t.workerPhone))}</p>${workerStrokes ? strokesToSvg(workerStrokes, '근로자 서명') : '<p class="muted">서명 대기</p>'}${wt ? `<p class="muted">서명 시각 ${kst(wt)}</p>` : ''}</section>
</div>
${id ? `<p class="muted">문서 ID: ${esc(id)}</p>` : ''}
${hash ? `<p class="muted break">계약 지문(SHA-256): ${esc(hash)}<br>계약 내용과 양측 서명으로 계산한 값입니다. 파일 변조 확인용이며 본인인증이 아닙니다. 서명 시각은 각자 기기의 시계 기준입니다.</p>` : ''}
</article>`;
}
export { won, kst };
