import { SignJWT, jwtVerify } from "jose";
import { serialize, parse } from "cookie";

export interface AccessTokenPayload {
  userId: string;
  email: string;
  role: string;
  firmId: string | null;
}

interface RefreshTokenPayload {
  userId: string;
  tokenId: string;
}

// Lazy-initialized secrets — avoids module-level evaluation during Next.js build
let _accessSecret: Uint8Array | null = null;
let _refreshSecret: Uint8Array | null = null;

function getAccessSecret(): Uint8Array {
  if (!_accessSecret) {
    const value = process.env.JWT_ACCESS_SECRET;
    if (!value) {
      throw new Error(
        "Missing required environment variable: JWT_ACCESS_SECRET"
      );
    }
    _accessSecret = new TextEncoder().encode(value);
  }
  return _accessSecret;
}

function getRefreshSecret(): Uint8Array {
  if (!_refreshSecret) {
    const value = process.env.JWT_REFRESH_SECRET;
    if (!value) {
      throw new Error(
        "Missing required environment variable: JWT_REFRESH_SECRET"
      );
    }
    _refreshSecret = new TextEncoder().encode(value);
  }
  return _refreshSecret;
}

function getExpiry(envVar: string, fallback: number): number {
  return parseInt(process.env[envVar] || String(fallback));
}

const IS_PRODUCTION = process.env.USE_SECURE_COOKIES === "true";

export async function signAccessToken(
  payload: AccessTokenPayload
): Promise<string> {
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(`${getExpiry("JWT_ACCESS_EXPIRY", 900)}s`)
    .setIssuedAt()
    .sign(getAccessSecret());
}

export async function signRefreshToken(
  payload: RefreshTokenPayload
): Promise<string> {
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(`${getExpiry("JWT_REFRESH_EXPIRY", 604800)}s`)
    .setIssuedAt()
    .sign(getRefreshSecret());
}

export async function verifyAccessToken(
  token: string
): Promise<AccessTokenPayload> {
  const { payload } = await jwtVerify(token, getAccessSecret());
  return payload as unknown as AccessTokenPayload;
}

export async function verifyRefreshToken(
  token: string
): Promise<RefreshTokenPayload> {
  const { payload } = await jwtVerify(token, getRefreshSecret());
  return payload as unknown as RefreshTokenPayload;
}

export function getAccessCookie(token: string): string {
  return serialize("tb_access", token, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: "lax",
    path: "/",
    maxAge: getExpiry("JWT_ACCESS_EXPIRY", 900),
  });
}

export function getRefreshCookie(token: string): string {
  return serialize("tb_refresh", token, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: "lax",
    path: "/",
    maxAge: getExpiry("JWT_REFRESH_EXPIRY", 604800),
  });
}

export function getClearCookies(): string[] {
  return [
    serialize("tb_access", "", {
      httpOnly: true,
      secure: IS_PRODUCTION,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    }),
    serialize("tb_refresh", "", {
      httpOnly: true,
      secure: IS_PRODUCTION,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    }),
  ];
}

export function parseCookies(
  cookieHeader: string | null
): Record<string, string | undefined> {
  return parse(cookieHeader || "");
}
