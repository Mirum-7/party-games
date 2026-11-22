export interface GameRealtime {
  publish(gameId: string, revision: number): void;
  subscribe(gameId: string, listener: (revision: number) => void): () => void;
}
