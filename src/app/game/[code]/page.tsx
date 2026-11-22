export default async function GamePage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <p className="text-muted-foreground">Комната {code}: модуль игры ещё не реализован.</p>
    </main>
  );
}
