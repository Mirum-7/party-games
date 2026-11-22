export type MutationOutcome = "ok" | "error";

export type MutationLogFields = {
  action: string;
  gameId: string | null;
  playerId: string | null;
  outcome: MutationOutcome;
  revision: number | null;
  correlationId: string;
};

export type LogSink = (line: string) => void;

export function createMutationLogger(
  sink: LogSink = (line) => {
    console.log(line);
  },
): (fields: MutationLogFields) => void {
  return (fields) => {
    sink(
      JSON.stringify({
        action: fields.action,
        gameId: fields.gameId,
        playerId: fields.playerId,
        outcome: fields.outcome,
        revision: fields.revision,
        correlationId: fields.correlationId,
      }),
    );
  };
}

export const logMutation = createMutationLogger();

export function logInternalError(
  correlationId: string,
  error: unknown,
  sink: LogSink = (line) => {
    console.error(line);
  },
): void {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  sink(JSON.stringify({ correlationId, errorName }));
}
