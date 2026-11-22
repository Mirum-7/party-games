-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "GameType" AS ENUM ('WORD_CHAIN');

-- CreateEnum
CREATE TYPE "GameStatus" AS ENUM ('LOBBY', 'ACTIVE', 'FINISHED');

-- CreateEnum
CREATE TYPE "WordChainPhase" AS ENUM ('ASSIGNING_WORDS', 'PLAYING');

-- CreateTable
CREATE TABLE "games" (
    "id" UUID NOT NULL,
    "code" VARCHAR(6) NOT NULL,
    "type" "GameType" NOT NULL,
    "status" "GameStatus" NOT NULL,
    "hostPlayerId" UUID,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "players" (
    "id" UUID NOT NULL,
    "gameId" UUID NOT NULL,
    "name" VARCHAR(24) NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "isReady" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_results" (
    "id" UUID NOT NULL,
    "gameId" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "place" INTEGER,
    "score" INTEGER NOT NULL DEFAULT 0,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "game_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "word_chain_games" (
    "gameId" UUID NOT NULL,
    "phase" "WordChainPhase",
    "hideTargetNamesDuringSetup" BOOLEAN NOT NULL DEFAULT false,
    "playingStartedAt" TIMESTAMP(3),

    CONSTRAINT "word_chain_games_pkey" PRIMARY KEY ("gameId")
);

-- CreateTable
CREATE TABLE "word_assignments" (
    "id" UUID NOT NULL,
    "gameId" UUID NOT NULL,
    "authorPlayerId" UUID NOT NULL,
    "targetPlayerId" UUID NOT NULL,
    "word" VARCHAR(80),
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "word_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "games_code_key" ON "games"("code");

-- CreateIndex
CREATE UNIQUE INDEX "games_hostPlayerId_key" ON "games"("hostPlayerId");

-- CreateIndex
CREATE UNIQUE INDEX "players_gameId_normalizedName_key" ON "players"("gameId", "normalizedName");

-- CreateIndex
CREATE UNIQUE INDEX "game_results_playerId_key" ON "game_results"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "game_results_gameId_playerId_key" ON "game_results"("gameId", "playerId");

-- CreateIndex
CREATE UNIQUE INDEX "game_results_gameId_place_key" ON "game_results"("gameId", "place");

-- CreateIndex
CREATE UNIQUE INDEX "word_assignments_authorPlayerId_key" ON "word_assignments"("authorPlayerId");

-- CreateIndex
CREATE UNIQUE INDEX "word_assignments_targetPlayerId_key" ON "word_assignments"("targetPlayerId");

-- CreateIndex
CREATE UNIQUE INDEX "word_assignments_gameId_authorPlayerId_key" ON "word_assignments"("gameId", "authorPlayerId");

-- CreateIndex
CREATE UNIQUE INDEX "word_assignments_gameId_targetPlayerId_key" ON "word_assignments"("gameId", "targetPlayerId");

-- AddForeignKey
ALTER TABLE "games" ADD CONSTRAINT "games_hostPlayerId_fkey" FOREIGN KEY ("hostPlayerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "players" ADD CONSTRAINT "players_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_results" ADD CONSTRAINT "game_results_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_results" ADD CONSTRAINT "game_results_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "word_chain_games" ADD CONSTRAINT "word_chain_games_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "word_assignments" ADD CONSTRAINT "word_assignments_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "word_assignments" ADD CONSTRAINT "word_assignments_authorPlayerId_fkey" FOREIGN KEY ("authorPlayerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "word_assignments" ADD CONSTRAINT "word_assignments_targetPlayerId_fkey" FOREIGN KEY ("targetPlayerId") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- CheckConstraints (docs/data-model.md)
ALTER TABLE "word_assignments" ADD CONSTRAINT "word_assignments_no_self_target"
  CHECK ("authorPlayerId" <> "targetPlayerId");
ALTER TABLE "word_assignments" ADD CONSTRAINT "word_assignments_word_submission_pair"
  CHECK (("word" IS NOT NULL) = ("submittedAt" IS NOT NULL));
ALTER TABLE "word_assignments" ADD CONSTRAINT "word_assignments_word_length"
  CHECK ("word" IS NULL OR char_length(btrim("word")) BETWEEN 1 AND 80);
ALTER TABLE "game_results" ADD CONSTRAINT "game_results_place_positive"
  CHECK ("place" IS NULL OR "place" >= 1);
ALTER TABLE "game_results" ADD CONSTRAINT "game_results_place_time_pair"
  CHECK (("finishedAt" IS NOT NULL) = ("place" IS NOT NULL));
ALTER TABLE "game_results" ADD CONSTRAINT "game_results_score_place_pair"
  CHECK (("score" > 0) = ("place" IS NOT NULL));
