import "server-only";

import { runGameCommand, requireHost, requireLobby, requireMember } from "@/server/core/games/command";
import type { CommandResult } from "@/server/core/games/command";
import { cryptoRandomInt, isValidRoomCode, normalizeRoomCode } from "@/server/core/games/code";
import type { GameDefinition } from "@/server/core/games/types";
import { GameCommandError, invalidInput } from "@/server/core/games/errors";
import type { GameRealtime } from "@/server/core/realtime/types";

import { submitWordSchema } from "./schemas";
import { assertSingleCycle, buildCycle, MAX_PLAYERS, MIN_PLAYERS, normalizeWord } from "./rules";
import { isValidWord, MAX_WORD_LENGTH } from "./validation";
import type { WordChainPhase } from "./types";

import { createWordChainGame, updateWordChainSettings } from "./settings";

// Сборка описания игры для реестра: Core вызывает хуки, не зная полей настроек
// и правил WORD_CHAIN.
export const wordChainGameDefinition: GameDefinition = {
  type: "WORD_CHAIN",
  minPlayers: 3,
  maxPlayers: 12,
  createGame: createWordChainGame,
  updateSettings: updateWordChainSettings,
};

const INVALID_CODE_MESSAGE = "Код комнаты состоит из шести символов без I, O, 0 и 1";
const INVALID_PHASE_MESSAGE = "Действие недопустимо в текущей фазе";

function normalizeCodeOrThrow(code: string): string {
  const normalized = normalizeRoomCode(code);
  if (!isValidRoomCode(normalized)) {
    throw invalidInput("code", INVALID_CODE_MESSAGE);
  }
  return normalized;
}

export type StartedWordChain = { playerCount: number };

// Запуск попытки: повторные проверки админа и фазы выполняются уже под
// блокировкой Game внутри runGameCommand. Игроки читаются в детерминированном
// порядке (joinedAt, id), распределение строит один цикл до записи, все
// назначения и переход ACTIVE/ASSIGNING_WORDS фиксируются одним commit.
export async function startWordChain(input: {
  code: string;
  playerId: string;
  realtime: GameRealtime;
}): Promise<CommandResult<StartedWordChain>> {
  const code = normalizeCodeOrThrow(input.code);

  return runGameCommand<StartedWordChain>({
    code,
    realtime: input.realtime,
    action: "start",
    command: async (tx, game) => {
      await requireMember(tx, game.id, input.playerId);
      requireHost(game, input.playerId);
      requireLobby(game);

      const players = await tx.player.findMany({
        where: { gameId: game.id },
        orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
        select: { id: true, isReady: true },
      });
      if (players.length < MIN_PLAYERS) {
        throw new GameCommandError("NOT_ENOUGH_PLAYERS", 409, "Для запуска нужно минимум три участника");
      }
      if (players.length > MAX_PLAYERS) {
        throw new GameCommandError("GAME_FULL", 409, `В комнате уже ${MAX_PLAYERS} игроков`);
      }
      if (!players.every((player) => player.isReady)) {
        throw new GameCommandError("NOT_ALL_READY", 409, "Не все участники готовы");
      }

      const pairs = buildCycle(
        players.map((player) => player.id),
        cryptoRandomInt,
      );
      assertSingleCycle(pairs);

      await tx.wordAssignment.createMany({
        data: pairs.map((pair) => ({ gameId: game.id, ...pair })),
      });
      await tx.game.update({
        where: { id: game.id },
        data: { status: "ACTIVE", startedAt: new Date() },
      });
      await tx.wordChainGame.update({
        where: { gameId: game.id },
        data: { phase: "ASSIGNING_WORDS" },
      });
      return { changed: true, value: { playerCount: players.length } };
    },
  });
}

export type SubmittedWord = { word: string; phase: WordChainPhase };

// Сохранение собственного слова: upsert только по (gameId, authorPlayerId =
// viewer). Совпавшее нормализованное значение — no-op без ревизии и
// публикации. Редактирование доступно до PLAYING; последнее отсутствующее
// слово атомарно переводит фазу и ставит playingStartedAt в той же транзакции.
export async function submitWord(input: {
  code: string;
  playerId: string;
  word: unknown;
  realtime: GameRealtime;
}): Promise<CommandResult<SubmittedWord>> {
  const code = normalizeCodeOrThrow(input.code);
  const parsed = submitWordSchema.safeParse({ word: input.word });
  if (!parsed.success) {
    throw invalidInput("word", "Некорректное тело запроса");
  }
  const word = normalizeWord(parsed.data.word);
  if (!isValidWord(word)) {
    throw invalidInput("word", `Слово должно содержать от 1 до ${MAX_WORD_LENGTH} символов`);
  }

  return runGameCommand<SubmittedWord>({
    code,
    realtime: input.realtime,
    action: "word",
    command: async (tx, game) => {
      await requireMember(tx, game.id, input.playerId);
      const wordChain = await tx.wordChainGame.findUniqueOrThrow({ where: { gameId: game.id } });
      if (game.status !== "ACTIVE" || wordChain.phase !== "ASSIGNING_WORDS") {
        throw new GameCommandError("INVALID_GAME_STATE", 409, INVALID_PHASE_MESSAGE);
      }

      const assignment = await tx.wordAssignment.findFirst({
        where: { gameId: game.id, authorPlayerId: input.playerId },
      });
      if (!assignment) {
        throw new GameCommandError("INVALID_GAME_STATE", 409, "Назначение автора не найдено");
      }
      if (assignment.word === word) {
        return { changed: false, value: { word, phase: "ASSIGNING_WORDS" } };
      }

      const submittedAt = new Date();
      await tx.wordAssignment.update({
        where: { id: assignment.id },
        data: { word, submittedAt },
      });

      const [total, submitted] = await Promise.all([
        tx.wordAssignment.count({ where: { gameId: game.id } }),
        tx.wordAssignment.count({ where: { gameId: game.id, submittedAt: { not: null } } }),
      ]);
      if (submitted === total) {
        await tx.wordChainGame.update({
          where: { gameId: game.id },
          data: { phase: "PLAYING", playingStartedAt: submittedAt },
        });
        return { changed: true, value: { word, phase: "PLAYING" } };
      }
      return { changed: true, value: { word, phase: "ASSIGNING_WORDS" } };
    },
  });
}

export type CancelledWordChain = { cancelled: true };

// Отмена ввода слов админом: удаляются только данные текущей попытки
// (назначения и результаты), готовность и attempt timestamps сбрасываются,
// игроки, админ и настройки сохраняются. Ревизия увеличивается один раз и не
// уменьшается, поэтому повторный запуск после готовности работает.
export async function cancelWordChain(input: {
  code: string;
  playerId: string;
  realtime: GameRealtime;
}): Promise<CommandResult<CancelledWordChain>> {
  const code = normalizeCodeOrThrow(input.code);

  return runGameCommand<CancelledWordChain>({
    code,
    realtime: input.realtime,
    action: "cancel",
    command: async (tx, game) => {
      await requireMember(tx, game.id, input.playerId);
      requireHost(game, input.playerId);
      const wordChain = await tx.wordChainGame.findUniqueOrThrow({ where: { gameId: game.id } });
      if (game.status !== "ACTIVE" || wordChain.phase !== "ASSIGNING_WORDS") {
        throw new GameCommandError("INVALID_GAME_STATE", 409, INVALID_PHASE_MESSAGE);
      }

      await tx.wordAssignment.deleteMany({ where: { gameId: game.id } });
      await tx.gameResult.deleteMany({ where: { gameId: game.id } });
      await tx.player.updateMany({
        where: { gameId: game.id },
        data: { isReady: false },
      });
      await tx.game.update({
        where: { id: game.id },
        data: { status: "LOBBY", startedAt: null, finishedAt: null },
      });
      await tx.wordChainGame.update({
        where: { gameId: game.id },
        data: { phase: null, playingStartedAt: null },
      });
      return { changed: true, value: { cancelled: true } };
    },
  });
}
