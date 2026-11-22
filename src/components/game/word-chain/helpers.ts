// Чистые хелперы экранов WORD_CHAIN: клиентская валидация ввода слова зеркалит
// серверные ограничения (1–80 кодовых точек после trim), форматирование
// длительности результата. Никаких серверных импортов.

export const MAX_WORD_LENGTH = 80;

export function normalizeWordInput(value: string): string {
  return value.trim();
}

export function wordInputError(rawValue: string): string | null {
  const word = normalizeWordInput(rawValue);
  if (word.length === 0) return "Введите слово";
  if ([...word].length > MAX_WORD_LENGTH) {
    return `Слово не должно быть длиннее ${MAX_WORD_LENGTH} символов`;
  }
  return null;
}

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const paddedMinutes = String(minutes).padStart(2, "0");
  const paddedSeconds = String(seconds).padStart(2, "0");
  if (hours > 0) return `${hours}:${paddedMinutes}:${paddedSeconds}`;
  return `${minutes}:${paddedSeconds}`;
}
