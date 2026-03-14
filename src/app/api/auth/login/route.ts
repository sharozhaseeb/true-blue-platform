import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/password";
import {
  signAccessToken,
  signRefreshToken,
  getAccessCookie,
  getRefreshCookie,
} from "@/lib/auth";
import { badRequest, unauthorized, internalError } from "@/lib/errors";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, password } = body;

    if (!email || !password) {
      return badRequest("Email and password are required");
    }

    // Find user with firm info
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { firm: true },
    });

    if (!user || !user.isActive) {
      return unauthorized("Invalid email or password");
    }

    // Verify password
    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return unauthorized("Invalid email or password");
    }

    // Clean up old refresh tokens for this user
    await prisma.refreshToken.deleteMany({
      where: { userId: user.id },
    });

    // Generate tokens
    const accessToken = await signAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      firmId: user.firmId,
    });

    const refreshTokenRecord = await prisma.refreshToken.create({
      data: {
        token: crypto.randomUUID(),
        userId: user.id,
        expiresAt: new Date(
          Date.now() +
            parseInt(process.env.JWT_REFRESH_EXPIRY || "604800") * 1000
        ),
      },
    });

    const refreshToken = await signRefreshToken({
      userId: user.id,
      tokenId: refreshTokenRecord.id,
    });

    const response = NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        firmId: user.firmId,
        firmName: user.firm?.name || null,
      },
    });

    response.headers.append("Set-Cookie", getAccessCookie(accessToken));
    response.headers.append("Set-Cookie", getRefreshCookie(refreshToken));

    return response;
  } catch (error) {
    console.error("Login error:", error);
    return internalError();
  }
}
