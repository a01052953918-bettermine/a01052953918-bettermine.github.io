// 근로조건 계산·검증 (서버 없는 정적 버전). 분 단위 계산, 최종 금액에서만 반올림.
export const MIN_WAGE_2026 = 10320;
export const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
export const DAY_LABELS = { MON: '월', TUE: '화', WED: '수', THU: '목', FRI: '금', SAT: '토', SUN: '일' };

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function timeMinutes(t) {
  if (typeof t !== 'string' || !TIME_RE.test(t)) throw new Error('시간은 HH:mm 형식으로 입력하세요.');
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
export function minutesBetween(start, end) {
  const d = timeMinutes(end) - timeMinutes(start);
  return d < 0 ? d + 1440 : d;
}
function nightMinutes(from, to) {
  let n = 0;
  for (let m = from; m < to; m++) if (m % 1440 >= 1320 || m % 1440 < 360) n++;
  return n;
}
// 편의용 기본값일 뿐, 체류시간이 곧 근로시간이라는 뜻이 아닙니다.
export function suggestedBreak(grossMinutes) {
  return grossMinutes >= 480 ? 60 : grossMinutes >= 240 ? 30 : 0;
}
export function toHHMM(totalMinutes) {
  const m = ((totalMinutes % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

/** i: {workDays, startTime, endTime, breakMinutes, breakStartTime, hourlyWage, workplaceScale} */
export function calculate(i) {
  const s = timeMinutes(i.startTime);
  const gross = minutesBetween(i.startTime, i.endTime);
  if (gross <= 0) throw new Error('출퇴근 시간이 같을 수 없습니다.');
  const days = i.workDays;
  if (!Array.isArray(days) || !days.length || days.some(d => !DAYS.includes(d)) || new Set(days).size !== days.length)
    throw new Error('근무 요일을 중복 없이 선택하세요.');
  if (!Number.isInteger(i.hourlyWage) || i.hourlyWage < 0 || i.hourlyWage > 1000000)
    throw new Error('시급을 0~1,000,000원의 정수로 입력하세요.');
  if (i.workplaceScale && !['UNDER_5', 'OVER_5'].includes(i.workplaceScale)) throw new Error('사업장 규모를 확인하세요.');
  const rest = i.breakMinutes;
  if (!Number.isInteger(rest) || rest < 0 || rest >= gross) throw new Error('휴게시간은 근무 구간보다 짧아야 합니다.');
  let restStart = s;
  if (rest > 0) {
    restStart = timeMinutes(i.breakStartTime);
    if (restStart < s) restStart += 1440;
    if (restStart <= s || restStart + rest >= s + gross) throw new Error('휴게시간은 근무 도중에 배치해야 합니다.');
  }
  const net = gross - rest;
  const weekly = net * days.length;
  const legalBreak = net >= 480 ? 60 : net >= 240 ? 30 : 0;
  const night = nightMinutes(s, s + gross) - (rest ? nightMinutes(restStart, restStart + rest) : 0);
  const nightRate = i.workplaceScale === 'OVER_5' ? 0.5 : 0;
  const nightPerDay = Math.round((night * i.hourlyWage * nightRate) / 60);
  const holidayApplicable = weekly >= 900; // 주 15시간 이상
  const holidayMinutes = holidayApplicable ? Math.min(480, weekly / 5) : 0;
  const holidayPay = Math.round((holidayMinutes * i.hourlyWage) / 60);
  const weeklySalary = Math.round((weekly * i.hourlyWage) / 60) + holidayPay + nightPerDay * days.length;
  const advice = [];
  if (rest < legalBreak) advice.push('실근로시간에 비해 휴게시간이 부족합니다.');
  if (i.hourlyWage < MIN_WAGE_2026) advice.push('2026년 최저임금 10,320원에 미달합니다.');
  if (net > 480 || weekly > 2400) advice.push('이 버전은 1일 8시간·주 40시간 이내의 동일 일정만 지원합니다.');
  advice.push('주휴 예상액은 개근과 계속근로 요건 충족을 가정한 값입니다. 실제 지급액은 출근기록과 계약기간에 따라 정산하세요.');
  return {
    grossMinutes: gross, breakMinutes: rest, legalBreakMinutes: legalBreak, isBreakValid: rest >= legalBreak,
    dailyNetMinutes: net, dailyNetHours: net / 60, weeklyDays: days.length, weeklyNetMinutes: weekly, weeklyNetHours: weekly / 60,
    holidayApplicable, weeklyHolidayHours: holidayMinutes / 60, weeklyHolidayMinutes: holidayMinutes, weeklyHolidayPay: holidayPay,
    effectiveWageWithHoliday: Math.round(i.hourlyWage + (weekly ? holidayPay / (weekly / 60) : 0)),
    nightMinutesPerDay: night, nightRate, nightPerDay,
    minimumWageOk: i.hourlyWage >= MIN_WAGE_2026,
    weeklySalary, monthlySalary: Math.round(weeklySalary * 4.345), advice,
  };
}

/** 주휴수당이 포함된 시급을 입력받아 기본시급으로 분리. 올림해서 약정 포함시급을 밑돌지 않게 한다. */
export function baseWageFromIncluded(included, schedule) {
  if (!Number.isInteger(included) || included < 1 || included > 2000000) throw new Error('주휴 포함 시급을 정수로 입력하세요.');
  const r = calculate({ ...schedule, hourlyWage: 0 });
  return Math.ceil((included * r.weeklyNetMinutes) / (r.weeklyNetMinutes + r.weeklyHolidayMinutes) - 1e-9);
}

const phoneOk = v => typeof v === 'string' && /^0\d{8,10}$/.test(v.replace(/[ -]/g, ''));
const textOk = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const dateOk = v => {
  if (typeof v !== 'string' || !/^2026-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const KEYS = ['businessName', 'ownerName', 'ownerPhone', 'workerName', 'workerPhone', 'workplaceScale', 'contractType', 'startDate', 'endDate',
  'workPlace', 'jobDescription', 'workDays', 'startTime', 'endTime', 'breakMinutes', 'breakStartTime', 'hourlyWage', 'holidayPayIncluded',
  'includedWage', 'weeklyHoliday', 'payDay'];

/** 계약 조건 검증. 링크로 들어온 데이터도 같은 규칙으로 걸러낸다. 반환: 오류 문구 배열(비어 있으면 통과) */
export function validateTerms(t) {
  const e = [];
  if (!t || typeof t !== 'object' || Array.isArray(t)) return ['계약 내용이 올바르지 않습니다.'];
  const extra = Object.keys(t).filter(k => !KEYS.includes(k));
  if (extra.length) return ['알 수 없는 항목이 있습니다: ' + extra.join(', ')];
  if (!textOk(t.businessName, 100)) e.push('상호명을 입력하세요.');
  if (!textOk(t.ownerName, 50)) e.push('대표자 성명을 입력하세요.');
  if (!phoneOk(t.ownerPhone)) e.push('사업주 연락처를 확인하세요.');
  if (!textOk(t.workerName, 50)) e.push('근로자 성명을 입력하세요.');
  if (!phoneOk(t.workerPhone)) e.push('근로자 연락처를 확인하세요.');
  if (!['UNDER_5', 'OVER_5'].includes(t.workplaceScale)) e.push('사업장 규모를 선택하세요.');
  if (!['PART_TIME', 'DAILY'].includes(t.contractType)) e.push('계약 유형을 선택하세요.');
  if (!dateOk(t.startDate) || !dateOk(t.endDate)) e.push('시작일·종료일은 2026년의 올바른 날짜여야 합니다. (이 버전은 2026년 계약만 지원)');
  if (!textOk(t.workPlace, 200)) e.push('근무장소를 입력하세요.');
  if (!textOk(t.jobDescription, 500)) e.push('업무내용을 입력하세요.');
  if (!textOk(t.payDay, 80)) e.push('임금 지급일을 입력하세요.');
  if (!Array.isArray(t.workDays) || !t.workDays.length || t.workDays.length > 6 || t.workDays.some(d => !DAYS.includes(d))) e.push('근무 요일을 선택하세요.');
  if (!DAYS.includes(t.weeklyHoliday)) e.push('지정 주휴일을 선택하세요.');
  if (typeof t.holidayPayIncluded !== 'boolean') e.push('주휴수당 표기 방식을 선택하세요.');
  if (t.includedWage != null && (!Number.isInteger(t.includedWage) || t.includedWage < 1 || t.includedWage > 2000000)) e.push('주휴 포함 시급을 확인하세요.');
  if (!Number.isInteger(t.hourlyWage) || t.hourlyWage < MIN_WAGE_2026) e.push('기본시급은 2026년 최저임금 10,320원 이상이어야 합니다.');
  if (e.length) return e;
  if (t.endDate < t.startDate) e.push('종료일은 시작일 이후여야 합니다.');
  if (t.workDays.includes(t.weeklyHoliday)) e.push('지정 주휴일을 근무 요일에서 제외하세요.');
  const day = (new Date(t.startDate + 'T00:00:00Z').getUTCDay() + 6) % 7;
  if (t.contractType === 'DAILY' && t.startDate !== t.endDate) e.push('일용 계약은 시작일과 종료일이 같아야 합니다.');
  if (t.contractType === 'DAILY' && (t.workDays.length !== 1 || t.workDays[0] !== DAYS[day])) e.push('일용 계약은 해당 날짜의 요일 하나만 선택하세요.');
  const span = (Date.parse(t.endDate) - Date.parse(t.startDate)) / 86400000;
  if (span < 6 && t.workDays.some(d => (DAYS.indexOf(d) - day + 7) % 7 > span)) e.push('계약기간에 없는 근무 요일을 선택했습니다.');
  try {
    const r = calculate(t);
    if (!r.isBreakValid) e.push('실근로시간에 비해 휴게시간이 부족합니다. (4시간 이상 30분, 8시간 1시간)');
    if (r.dailyNetMinutes > 480 || r.weeklyNetMinutes > 2400) e.push('이 버전은 1일 8시간·주 40시간 이내만 지원합니다.');
  } catch (err) {
    e.push(err.message);
  }
  return e;
}
