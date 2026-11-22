import type { GameStatus, PublicPhase, ResultSortKey, WordChainPhase } from "./types";

export type RandomInt = (maxExclusive: number) => number;

export type AssignmentPair = {
  authorPlayerId: string;
  targetPlayerId: string;
};

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 12;

export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function buildCycle(playerIds: readonly string[], randomInt: RandomInt): AssignmentPair[] {
  if (playerIds.length < MIN_PLAYERS || playerIds.length > MAX_PLAYERS || new Set(playerIds).size !== playerIds.length) {
    throw new Error("INVALID_PLAYER_SET");
  }
  const order = [...playerIds];
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    if (!Number.isInteger(j) || j < 0 || j > i) throw new Error("RNG_OUT_OF_RANGE");
    [order[i], order[j]] = [order[j], order[i]];
  }
  const pairs = order.map((authorPlayerId, i) => ({
    authorPlayerId,
    targetPlayerId: order[(i + 1) % order.length],
  }));
  assertSingleCycle(pairs);
  return pairs;
}

export function assertSingleCycle(pairs: readonly AssignmentPair[]): void {
  if (pairs.length === 0) throw new Error("SINGLE_CYCLE_REQUIRED");

  const targetByAuthor = new Map<string, string>();
  const authors = new Set<string>();
  const targets = new Set<string>();
  for (const pair of pairs) {
    if (pair.authorPlayerId === pair.targetPlayerId) throw new Error("SINGLE_CYCLE_REQUIRED");
    if (targetByAuthor.has(pair.authorPlayerId)) throw new Error("SINGLE_CYCLE_REQUIRED");
    targetByAuthor.set(pair.authorPlayerId, pair.targetPlayerId);
    authors.add(pair.authorPlayerId);
    targets.add(pair.targetPlayerId);
  }
  if (authors.size !== pairs.length || targets.size !== pairs.length) {
    throw new Error("SINGLE_CYCLE_REQUIRED");
  }

  // Обход от первого автора: ровно N шагов до возврата в начало;
  // преждевременная повторная вершина или обрыв цепочки — подцикл
  // или недопустимый адресат.
  const start = pairs[0].authorPlayerId;
  const visited = new Set<string>();
  let current = start;
  for (let step = 0; step < pairs.length; step += 1) {
    if (visited.has(current)) throw new Error("SINGLE_CYCLE_REQUIRED");
    visited.add(current);
    const next = targetByAuthor.get(current);
    if (next === undefined) throw new Error("SINGLE_CYCLE_REQUIRED");
    current = next;
  }
  if (current !== start || visited.size !== pairs.length) {
    throw new Error("SINGLE_CYCLE_REQUIRED");
  }
}

export function normalizeName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function nameKey(value: string): string {
  return normalizeName(value).toLowerCase();
}

export function normalizeWord(value: string): string {
  return value.trim();
}

export function normalizeCode(value: string): string {
  return value.replace(/\s+/gu, "").toUpperCase();
}

export function generateRoomCode(randomInt: RandomInt): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    const index = randomInt(ROOM_CODE_ALPHABET.length);
    if (!Number.isInteger(index) || index < 0 || index >= ROOM_CODE_ALPHABET.length) {
      throw new Error("RNG_OUT_OF_RANGE");
    }
    code += ROOM_CODE_ALPHABET[index];
  }
  return code;
}

export function getPublicPhase(status: GameStatus, phase: WordChainPhase | null): PublicPhase {
  if (status === "LOBBY" && phase === null) return "LOBBY";
  if (status === "ACTIVE" && phase === "ASSIGNING_WORDS") return "ASSIGNING_WORDS";
  if (status === "ACTIVE" && phase === "PLAYING") return "PLAYING";
  if (status === "FINISHED" && phase === "PLAYING") return "FINISHED";
  throw new Error("INVALID_GAME_STATE");
}

export function canStart(playerCount: number, allPlayersReady: boolean): boolean {
  return (
    Number.isInteger(playerCount) &&
    playerCount >= MIN_PLAYERS &&
    playerCount <= MAX_PLAYERS &&
    allPlayersReady
  );
}

export function scoreForPlace(playerCount: number, place: number): number {
  return playerCount - place + 1;
}

export function compareResults(a: ResultSortKey, b: ResultSortKey): number {
  if (a.place !== null || b.place !== null) {
    if (a.place === null) return 1;
    if (b.place === null) return -1;
    if (a.place !== b.place) return a.place - b.place;
  }
  if (a.normalizedName < b.normalizedName) return -1;
  if (a.normalizedName > b.normalizedName) return 1;
  if (a.playerId < b.playerId) return -1;
  if (a.playerId > b.playerId) return 1;
  return 0;
}
