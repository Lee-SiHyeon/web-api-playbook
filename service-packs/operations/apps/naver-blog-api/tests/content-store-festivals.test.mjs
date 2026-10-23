import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFestival, upcoming, collectFestivals } from '../research/content-store/festivals.mjs';

const row = { fstvlCntntsId: 'a1', cntntsNm: ' 창경궁 야연 ', fstvlBgngDe: '2026.09.24', fstvlEndDe: '2026.10.04', fstvlDayDiff: '4', fstvlIngFlag: '0',
  fstvlClCd: 'MF', areaNm: '서울특별시 종로구', adres: '서울특별시 종로구 창경궁로 185', ycrdVal: '37.57', xcrdVal: '126.99',
  fstvlHmpgUrl: '<a href="https://x.kr/a" target="_blank">https://x.kr/a</a> ', boothInfoList: [{ boothNm: '꼬치' }] };

test('festival rows normalize dates, coordinates, homepage and booths', () => {
  const f = normalizeFestival(row);
  assert.deepEqual([f.name, f.start, f.end, f.lat, f.lng, f.homepage, f.cultureTourismFestival, f.ongoing], ['창경궁 야연', '2026-09-24', '2026-10-04', 37.57, 126.99, 'https://x.kr/a', true, true]);
  assert.deepEqual(f.foodBooths, ['꼬치']);
});

test('upcoming keeps festivals overlapping the window in the area, earliest first', () => {
  const fs = [normalizeFestival(row), normalizeFestival({ ...row, fstvlCntntsId: 'b', fstvlBgngDe: '2026.12.01', fstvlEndDe: '2026.12.03' }),
    normalizeFestival({ ...row, fstvlCntntsId: 'c', areaNm: '부산광역시', fstvlBgngDe: '2026.09.30', fstvlEndDe: '2026.10.01' })];
  assert.deepEqual(upcoming(fs, { today: '2026-09-28', days: 10, area: '서울' }).map(f => f.id), ['a1']);
  assert.deepEqual(upcoming(fs, { today: '2026-09-28', days: 10 }).map(f => f.id), ['a1', 'c']);
});

test('collector pages with form-encoded startIdx until the total is reached', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => { bodies.push(init.body.get('startIdx')); const i = Number(init.body.get('startIdx'));
    return { status: 200, json: async () => ({ totalCnt: 14, resultList: i === 0 ? Array.from({ length: 12 }, (_, k) => ({ ...row, fstvlCntntsId: `r${k}` })) : [{ ...row, fstvlCntntsId: 'r12' }, { ...row, fstvlCntntsId: 'r13' }] }) }; };
  const res = await collectFestivals({ fetchImpl, delayMs: 0 });
  assert.equal(res.festivals.length, 14);
  assert.deepEqual(bodies, ['0', '12']);
});
