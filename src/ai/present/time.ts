import { PRESENT_CONFIG as C } from './config.ts';

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
const OFFSET_MS = C.utcOffsetHours * 3_600_000;

/** 日本時間の日付キー 'YYYY-MM-DD' */
export function localDateKey(time: string | number): string {
  const t = typeof time === 'number' ? time : Date.parse(time);
  return new Date(t + OFFSET_MS).toISOString().slice(0, 10);
}

/** 日付キーの0時（日本時間）を UTC ミリ秒で返す */
export function localDayStart(key: string): number {
  return Date.parse(`${key}T00:00:00Z`) - OFFSET_MS;
}

export function addDaysKey(key: string, days: number): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' → '11月7日' */
export function formatJapaneseDate(key: string): string {
  const [, m, d] = key.split('-').map(Number);
  return `${m}月${d}日`;
}

/** 翌朝の指定時刻（日本時間） */
export function nextMorning(now: string): string {
  const tomorrow = addDaysKey(localDateKey(now), 1);
  return new Date(localDayStart(tomorrow) + C.morningHour * 3_600_000).toISOString();
}
