export function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function yesterdayDateKey(date = new Date()) {
  const yesterday = new Date(date);
  yesterday.setDate(yesterday.getDate() - 1);
  return localDateKey(yesterday);
}
