import {
  getIronSession,
  type CookieJar,
  type CookieStore,
  type IronSession,
  type SessionOptions,
} from "iron-session";

export type GuestSession = {
  playerId: string;
};

export const SESSION_COOKIE_NAME = "wg_session";
export const SESSION_TTL_SECONDS = 604800; // 7 дней

type SessionCookieStore = CookieStore | CookieJar;

export function buildSessionOptions(password: string, isProduction: boolean): SessionOptions {
  if (password.length < 32) {
    throw new Error("SESSION_PASSWORD must be at least 32 characters long");
  }
  return {
    cookieName: SESSION_COOKIE_NAME,
    password,
    ttl: SESSION_TTL_SECONDS,
    cookieOptions: {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: isProduction,
      maxAge: SESSION_TTL_SECONDS,
    },
  };
}

export function getSessionOptions(): SessionOptions {
  const password = process.env.SESSION_PASSWORD;
  if (password === undefined || password.length === 0) {
    throw new Error("SESSION_PASSWORD environment variable is required");
  }
  return buildSessionOptions(password, process.env.NODE_ENV === "production");
}

export async function readGuestSession(store: SessionCookieStore): Promise<IronSession<GuestSession>> {
  return getIronSession<GuestSession>(store, getSessionOptions());
}

export async function writeGuestPlayer(store: SessionCookieStore, playerId: string): Promise<void> {
  const session = await readGuestSession(store);
  session.playerId = playerId;
  await session.save();
}

export async function destroyGuestSession(store: SessionCookieStore): Promise<void> {
  const session = await readGuestSession(store);
  session.destroy();
}

export async function getGuestSession(): Promise<IronSession<GuestSession>> {
  const { cookies } = await import("next/headers");
  return readGuestSession(await cookies());
}

export async function setGuestPlayer(playerId: string): Promise<void> {
  const session = await getGuestSession();
  session.playerId = playerId;
  await session.save();
}

export async function clearGuestSession(): Promise<void> {
  const session = await getGuestSession();
  session.destroy();
}

export async function getOptionalPlayerId(store?: SessionCookieStore): Promise<string | null> {
  const session = store === undefined ? await getGuestSession() : await readGuestSession(store);
  const playerId = session.playerId;
  return typeof playerId === "string" && playerId.length > 0 ? playerId : null;
}
