import "server-only";

import type { Game, GameResult, Player, WordAssignment, WordChainGame } from "@/generated/prisma/client";
import type { Capabilities, HintItem, PlayerRef, ResultItem, SetupState } from "@/shared/contracts/game";

import { compareResults, getPublicPhase } from "./rules";

export type WordChainProjectionInput = {
  game: Game;
  wordChain: WordChainGame;
  players: Player[];
  viewer: Player;
  assignments: WordAssignment[];
  results: GameResult[];
};

export type WordChainGameCapabilities = Pick<
  Capabilities,
  "canSubmitWord" | "canMarkGuessed" | "canFinish" | "canCancel"
>;

export type WordChainProjection = {
  setup: SetupState | null;
  hints: HintItem[] | null;
  results: ResultItem[] | null;
  capabilities: WordChainGameCapabilities;
};

const NO_GAME_CAPABILITIES: WordChainGameCapabilities = {
  canSubmitWord: false,
  canMarkGuessed: false,
  canFinish: false,
  canCancel: false,
};

export function projectWordChain(input: WordChainProjectionInput): WordChainProjection {
  // getPublicPhase отклоняет недопустимые сочетания статуса и фазы.
  const phase = getPublicPhase(input.game.status, input.wordChain.phase);
  switch (phase) {
    case "LOBBY":
      return { setup: null, hints: null, results: null, capabilities: { ...NO_GAME_CAPABILITIES } };
    case "ASSIGNING_WORDS":
      return projectAssigningWords(input);
    case "PLAYING":
      return projectPlaying(input);
    case "FINISHED":
      return projectFinished(input);
  }
  throw new Error("INVALID_GAME_STATE");
}

function projectAssigningWords(input: WordChainProjectionInput): WordChainProjection {
  const { wordChain, players, viewer, assignments } = input;
  const ownAssignment = assignments.find((assignment) => assignment.authorPlayerId === viewer.id) ?? null;
  const hideTarget = wordChain.hideTargetNamesDuringSetup;
  const setup: SetupState = {
    target: ownAssignment !== null && !hideTarget ? playerRef(players, ownAssignment.targetPlayerId) : null,
    targetHidden: hideTarget,
    word: ownAssignment?.word ?? null,
  };
  return {
    setup,
    hints: null,
    results: null,
    capabilities: {
      ...NO_GAME_CAPABILITIES,
      // Редактирование сохранённого слова разрешено до перехода в PLAYING:
      // право есть, пока существует собственное назначение.
      canSubmitWord: ownAssignment !== null,
    },
  };
}

function projectPlaying(input: WordChainProjectionInput): WordChainProjection {
  const { game, players, viewer, assignments, results } = input;
  assertAllWordsAssigned(assignments);
  const hints = orderedAssignments(assignments).map((assignment) => {
    const hidden = assignment.targetPlayerId === viewer.id;
    return {
      assignmentId: assignment.id,
      author: playerRef(players, assignment.authorPlayerId),
      target: playerRef(players, assignment.targetPlayerId),
      word: hidden ? null : assignment.word,
      wordHidden: hidden,
    };
  });
  const hasPlacedResult = results.some((result) => result.playerId === viewer.id && result.place !== null);
  return {
    setup: null,
    hints,
    results: null,
    capabilities: {
      ...NO_GAME_CAPABILITIES,
      canMarkGuessed: !hasPlacedResult,
      canFinish: game.hostPlayerId === viewer.id,
    },
  };
}

function projectFinished(input: WordChainProjectionInput): WordChainProjection {
  const { wordChain, players, assignments, results } = input;
  assertAllWordsAssigned(assignments);
  const playingStartedAt = wordChain.playingStartedAt;
  if (playingStartedAt === null) throw new Error("INVALID_GAME_STATE");
  const hints = orderedAssignments(assignments).map((assignment) => ({
    assignmentId: assignment.id,
    author: playerRef(players, assignment.authorPlayerId),
    target: playerRef(players, assignment.targetPlayerId),
    word: assignment.word,
    wordHidden: false,
  }));
  const ranked = players.map((player) => ({
    player,
    result: results.find((candidate) => candidate.playerId === player.id) ?? null,
  }));
  ranked.sort((a, b) =>
    compareResults(
      { place: a.result?.place ?? null, normalizedName: a.player.normalizedName, playerId: a.player.id },
      { place: b.result?.place ?? null, normalizedName: b.player.normalizedName, playerId: b.player.id },
    ),
  );
  const resultItems: ResultItem[] = ranked.map(({ player, result }) => {
    const place = result?.place ?? null;
    const finishedAt = result?.finishedAt ?? null;
    if (place !== null && finishedAt === null) throw new Error("INVALID_GAME_STATE");
    return {
      playerId: player.id,
      name: player.name,
      place,
      score: result?.score ?? 0,
      durationMs: place !== null && finishedAt !== null ? finishedAt.getTime() - playingStartedAt.getTime() : null,
    };
  });
  return { setup: null, hints, results: resultItems, capabilities: { ...NO_GAME_CAPABILITIES } };
}

function playerRef(players: readonly Player[], playerId: string): PlayerRef {
  const player = players.find((candidate) => candidate.id === playerId);
  if (!player) throw new Error("INVALID_GAME_STATE");
  return { id: player.id, name: player.name };
}

function orderedAssignments(assignments: readonly WordAssignment[]): WordAssignment[] {
  return [...assignments].sort((a, b) => {
    const byCreatedAt = a.createdAt.getTime() - b.createdAt.getTime();
    if (byCreatedAt !== 0) return byCreatedAt;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
}

function assertAllWordsAssigned(assignments: readonly WordAssignment[]): void {
  for (const assignment of assignments) {
    if (assignment.word === null) throw new Error("INVALID_GAME_STATE");
  }
}
