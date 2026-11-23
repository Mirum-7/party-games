export type CreateGameRequest = {
  name: string;
  gameType?: "WORD_CHAIN"; // по умолчанию WORD_CHAIN
};

export type JoinGameRequest = {
  name: string;
};

export type UpdateSettingsRequest = {
  hideTargetNamesDuringSetup: boolean;
};

export type ReadinessRequest = {
  ready: boolean;
};

export type SubmitWordRequest = {
  word: string;
};

export type GamePhase = "LOBBY" | "ASSIGNING_WORDS" | "PLAYING" | "FINISHED";

export type PlayerSummary = {
  id: string;
  name: string;
  isHost: boolean;
  isReady: boolean;
  hasSubmittedWord: boolean;
  hasGuessed: boolean;
};

export type PlayerRef = {
  id: string;
  name: string;
};

export type SetupState = {
  target: PlayerRef | null;
  targetHidden: boolean;
  word: string | null;
};

export type HintItem = {
  assignmentId: string;
  author: PlayerRef;
  target: PlayerRef;
  word: string | null;
  wordHidden: boolean;
};

export type ResultItem = {
  playerId: string;
  name: string;
  place: number | null;
  score: number;
  durationMs: number | null;
};

export type Capabilities = {
  canEditSettings: boolean;
  canManagePlayers: boolean;
  canStart: boolean;
  canSubmitWord: boolean;
  canMarkGuessed: boolean;
  canFinish: boolean;
  canCancel: boolean;
  canRestart: boolean;
  canLeave: boolean;
};

export type GameStateResponse = {
  game: {
    code: string;
    type: "WORD_CHAIN";
    phase: GamePhase;
    revision: number;
    minPlayers: 3;
    maxPlayers: 12;
    settings: {
      hideTargetNamesDuringSetup: boolean;
    };
    startedAt: string | null;
    playingStartedAt: string | null;
    finishedAt: string | null;
  };
  viewer: {
    playerId: string;
  };
  players: PlayerSummary[];
  setup: SetupState | null;
  hints: HintItem[] | null;
  results: ResultItem[] | null;
  capabilities: Capabilities;
};
