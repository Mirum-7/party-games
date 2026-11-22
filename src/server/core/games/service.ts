import "server-only";

import { prisma } from "@/server/db";
import type { GameRealtime } from "@/server/core/realtime/types";
import { runGameCommand, requireHost, requireLobby, requireMember } from "@/server/core/games/command";
import { generateRoomCode, cryptoRandomInt, isValidRoomCode, normalizeRoomCode } from "@/server/core/games/code";
import type { RandomInt } from "@/server/core/games/code";
import { invalidInput } from "@/server/core/games/errors";
import { GameCommandError } from "@/server/core/games/errors";
import { wordChainSettingsSchema } from "@/server/core/games/schemas";
import type { CommandResult } from "@/server/core/games/command";
import type { GameDefinition } from "@/server/core/games/types";
import { normalizeAndValidatePlayerName } from "@/server/core/players/schemas";

const CODE_GENERATION_MAX_ATTEMPTS = 20;

export type CreatedGame = {
  gameId: string;
  code: string;
  revision: number;
  playerId: string;
  name: string;
};

// Создание комнаты: Game + админ-Player + игровая запись в одной транзакции.
// Повторяется только при нарушении уникальности кода.
export async function createGame(input: {
  definition: GameDefinition;
  name: string;
  randomInt?: RandomInt;
}): Promise<CreatedGame> {
  const { name, key } = normalizeAndValidatePlayerName(input.name);
  const nextInt = input.randomInt ?? cryptoRandomInt;

  for (let attempt = 0; attempt < CODE_GENERATION_MAX_ATTEMPTS; attempt += 1) {
    const code = generateRoomCode(nextInt);
    try {
      return await prisma.$transaction(async (tx) => {
        const game = await tx.game.create({
          data: { code, type: input.definition.type, status: "LOBBY" },
        });
        const player = await tx.player.create({
          data: { gameId: game.id, name, normalizedName: key },
        });
        await input.definition.createGame(tx, game.id);
        await tx.game.update({ where: { id: game.id }, data: { hostPlayerId: player.id } });
        return { gameId: game.id, code, revision: game.revision, playerId: player.id, name };
      });
    } catch (error) {
      if (attempt + 1 < CODE_GENERATION_MAX_ATTEMPTS && isUniqueCodeViolation(error)) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("ROOM_CODE_GENERATION_FAILED");
}

function isUniqueCodeViolation(error: unknown): boolean {
  // Достаём уткой: под pg-адаптером meta.target отсутствует, а instanceof
  // ненадёжен из-за двойной загрузки классов Prisma.
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === "P2002" &&
    typeof candidate.message === "string" &&
    candidate.message.includes("games_code_key")
  );
}

export type JoinedPlayer = {
  playerId: string;
  name: string;
  isNewPlayer: boolean;
};

// Вход: существующий участник этой комнаты по cookie всегда получает no-op
// без дубликата; новый игрок допускается только в LOBBY, при свободном месте
// и уникальном имени. Cookie здесь не трогаем — её обновляет вызывающий слой
// после commit.
export async function joinGame(input: {
  definition: GameDefinition;
  code: string;
  name: string;
  playerId: string | null;
  realtime: GameRealtime;
}): Promise<CommandResult<JoinedPlayer>> {
  const code = normalizeRoomCode(input.code);
  if (!isValidRoomCode(code)) {
    throw invalidInput("code", "Код комнаты состоит из шести символов без I, O, 0 и 1");
  }

  return runGameCommand<JoinedPlayer>({
    code,
    realtime: input.realtime,
    action: "join",
    command: async (tx, game) => {
      if (input.playerId !== null) {
        const existing = await tx.player.findFirst({
          where: { id: input.playerId, gameId: game.id },
        });
        if (existing) {
          return {
            changed: false,
            value: { playerId: existing.id, name: existing.name, isNewPlayer: false },
          };
        }
      }

      requireLobby(game);
      const playerCount = await tx.player.count({ where: { gameId: game.id } });
      if (playerCount >= input.definition.maxPlayers) {
        throw new GameCommandError("GAME_FULL", 409, `В комнате уже ${input.definition.maxPlayers} игроков`);
      }

      const { name, key } = normalizeAndValidatePlayerName(input.name);
      const nameTaken = await tx.player.findFirst({
        where: { gameId: game.id, normalizedName: key },
      });
      if (nameTaken) {
        throw new GameCommandError("NAME_TAKEN", 409, "Это имя уже занято в комнате", {
          name: ["Выберите другое имя"],
        });
      }

      const player = await tx.player.create({
        data: { gameId: game.id, name, normalizedName: key },
      });
      return { changed: true, value: { playerId: player.id, name, isNewPlayer: true } };
    },
  });
}

// Настройки меняет только админ и только в LOBBY. Запись выполняет игровой
// модуль через хук GameDefinition.updateSettings; Core не знает полей настроек.
export async function updateSettings(input: {
  definition: GameDefinition;
  code: string;
  playerId: string;
  settings: unknown;
  realtime: GameRealtime;
}): Promise<CommandResult<{ hideTargetNamesDuringSetup: boolean }>> {
  const parsed = wordChainSettingsSchema.safeParse(input.settings);
  if (!parsed.success) {
    throw invalidInput("settings", "Некорректное тело настроек");
  }

  return runGameCommand({
    code: normalizeRoomCode(input.code),
    realtime: input.realtime,
    action: "settings",
    command: async (tx, game) => {
      await requireMember(tx, game.id, input.playerId);
      requireHost(game, input.playerId);
      requireLobby(game);

      const changed = await input.definition.updateSettings(tx, game.id, parsed.data);
      return { changed, value: parsed.data };
    },
  });
}
