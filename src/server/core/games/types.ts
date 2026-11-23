import type { Game, GameResult, Player } from "@/generated/prisma/client";
import type { TransactionClient } from "@/server/db";
import type {
  Capabilities,
  GamePhase,
  GameStateResponse,
  HintItem,
  ResultItem,
  SetupState,
} from "@/shared/contracts/game";

// Вход хука проекции: Core уже загрузил согласованный repeatable-read набор
// своих записей (Game, Player, GameResult) и передаёт его модулю. Модуль читает
// через tx только свои игровые таблицы и в зависимости от фазы.
export type GameProjectInput = {
  game: Game;
  viewer: Player;
  players: Player[]; // отсортированы по (joinedAt, id)
  results: GameResult[]; // Core-owned, нужны модулю для его проекции
};

// Core-owned capabilities: их значения вычисляет Core из роли viewer и
// публичной фазы. Игровой модуль обязан их не задавать и не может
// переопределить через свою проекцию.
export type CoreOwnedCapabilities = Pick<
  Capabilities,
  "canEditSettings" | "canManagePlayers" | "canStart" | "canRestart" | "canLeave"
>;

// Capabilities, которые игровой модуль вправе выставлять в своей проекции.
export type GameModuleCapabilities = Omit<Capabilities, keyof CoreOwnedCapabilities>;

// Результат проекции игрового модуля. Поле submittedWordPlayerIds служебное:
// Core строит им флаги PlayerSummary.hasSubmittedWord и не сериализует его
// в GameStateResponse.
export type GameProjectedState = {
  phase: GamePhase;
  settings: GameStateResponse["game"]["settings"];
  playingStartedAt: Date | null;
  setup: SetupState | null;
  hints: HintItem[] | null;
  results: ResultItem[] | null;
  capabilities: Partial<GameModuleCapabilities>;
  submittedWordPlayerIds: readonly string[];
};

// Описание типа игры, известное Core. Реализация конкретной игры привязывается
// только в composition root (src/server/games/registry.ts): Core вызывает эти
// хуки и не знает игровых полей и правил.
export type GameDefinition = {
  readonly type: "WORD_CHAIN";
  readonly minPlayers: 3;
  readonly maxPlayers: 12;
  createGame(tx: TransactionClient, gameId: string): Promise<void>;
  updateSettings(tx: TransactionClient, gameId: string, input: unknown): Promise<boolean>;
  resetAttempt(tx: TransactionClient, gameId: string): Promise<void>;
  project(tx: TransactionClient, input: GameProjectInput): Promise<GameProjectedState>;
};
