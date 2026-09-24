const UTC_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;

/**
 * Valida que un string ISO-8601 UTC (terminado en "Z") corresponda a una
 * fecha/hora real, no solo con la forma correcta. Rechaza combinaciones
 * sintacticamente validas pero inexistentes como "2026-02-30T00:00:00Z" o
 * "2026-13-01T00:00:00Z". El "pattern" del schema por si solo solo valida
 * la forma; esta funcion cubre el calendario.
 */
export function isValidUtcDateTime(value: string): boolean {
  const match = UTC_DATE_TIME_PATTERN.exec(value);
  if (!match) {
    return false;
  }

  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const second = Number(secondStr);

  if (month < 1 || month > 12) {
    return false;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return false;
  }

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}
