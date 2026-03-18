import { SignJWT, jwtVerify } from "jose";
import { serialize, parse } from "cookie";
import { Role } from "@prisma/client";

export interface AccessTokenPayload {
  userId: string;
  email: string;
  role: Role;
  firmId: string | null;
}

interface RefreshTokenPayload {
  userId: string;
  tokenId: string;
}

const ACCESS_SECRET = new TextEncoder().encode(
  process.env.JWT_ACCESS_SECRET || "fallback-dev-secret"
);
const REFRESH_SECRET = new TextEncoder().encode(
  process.env.JWT_REFRESH_SECRET || "fallback-dev-secret"
);
const ACCESS_EXPIRY = parseInt(process.env.JWT_ACCESS_EXPIRY || "900"); // 15 min
const REFRESH_EXPIRY = parseInt(process.env.JWT_REFRESH_EXPIRY || "604800"); // 7 days
const IS_PRODUCTION = process.env.USE_SECURE_COOKIES === "true";

export async function signAccessToken(
  payload: AccessTokenPayload
): Promise<string> {
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(`${ACCESS_EXPIRY}s`)
    .setIssuedAt()
    .sign(ACCESS_SECRET);
}

export async function signRefreshToken(
  payload: RefreshTokenPayload
): Promise<string> {
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(`${REFRESH_EXPIRY}s`)
    .setIssuedAt()
    .sign(REFRESH_SECRET);
}

export async function verifyAccessToken(
  token: string
): Promise<AccessTokenPayload> {
  const { payload } = await jwtVerify(token, ACCESS_SECRET);
  return payload as unknown as AccessTokenPayload;
}

export async function verifyRefreshToken(
  token: string
): Promise<RefreshTokenPayload> {
  const { payload } = await jwtVerify(token, REFRESH_SECRET);
  return payload as unknown as RefreshTokenPayload;
}

export function getAccessCookie(token: string): string {
  return serialize("tb_access", token, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: "lax",
    path: "/",
    maxAge: ACCESS_EXPIRY,
  });
}

export function getRefreshCookie(token: string): string {
  return serialize("tb_refresh", token, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: "lax",
    path: "/",
    maxAge: REFRESH_EXPIRY,
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
