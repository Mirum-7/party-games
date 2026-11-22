export type GameStatus = "LOBBY" | "ACTIVE" | "FINISHED";

export type WordChainPhase = "ASSIGNING_WORDS" | "PLAYING";

export type PublicPhase = "LOBBY" | "ASSIGNING_WORDS" | "PLAYING" | "FINISHED";

export type ResultSortKey = {
  readonly place: number | null;
  readonly normalizedName: string;
  readonly playerId: string;
};
