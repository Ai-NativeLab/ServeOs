/** "Tue 18:30" in the given IANA timezone. */
export function formatSlotLabel(date: Date, timeZone: string): string {
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short" }).format(date);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
  return `${weekday} ${time}`;
}

/** "Tue 7 Jul, 18:30" in the given IANA timezone. */
export function formatDayTime(date: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone, weekday: "short", day: "numeric", month: "short",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
  return `${day}, ${time}`;
}
