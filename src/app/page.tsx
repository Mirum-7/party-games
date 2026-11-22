import { HomeFormsFlow } from "@/components/game/home-forms";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-stretch justify-center gap-6 p-4">
      <div className="flex flex-col gap-1 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Words Game</h1>
        <p className="text-muted-foreground">
          Мобильная party-игра: загадывайте слова по кругу, объясняйте вживую.
        </p>
      </div>
      <HomeFormsFlow />
    </main>
  );
}
