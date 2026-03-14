import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  verifyRefreshToken,
  signAccessToken,
  signRefreshToken,
  getAccessCookie,
  getRefreshCookie,
  getClearCookies,
} from "@/lib/auth";
import { unauthorized, internalError } from "@/lib/errors";

export async function POST(request: NextRequest) {
  try {
    const refreshCookie = request.cookies.get("tb_refresh")?.value;

    if (!refreshCookie) {
      return unauthorized("No refresh token");
    }

    // Verify JWT signature
    let payload;
    try {
      payload = await verifyRefreshToken(refreshCookie);
    } catch {
      return unauthorized("Invalid refresh token");
    }

    // Find the token record in DB
    const tokenRecord = await prisma.refreshToken.findUnique({
      where: { id: payload.tokenId },
    });

    if (!tokenRecord || tokenRecord.expiresAt < new Date()) {
      // Token revoked or expired — clear cookies
      if (tokenRecord) {
        await prisma.refreshToken.delete({ where: { id: tokenRecord.id } });
      }
      const response = unauthorized("Refresh token expired");
      getClearCookies().forEach((cookie) => {
        response.headers.append("Set-Cookie", cookie);
      });
      return response;
    }

    // Delete old token (rotation — each token used only once)
    await prisma.refreshToken.delete({ where: { id: tokenRecord.id } });

    // Load fresh user data
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { firm: true },
    });

    if (!user || !user.isActive) {
      const response = unauthorized("User not found or inactive");
      getClearCookies().forEach((cookie) => {
        response.headers.append("Set-Cookie", cookie);
      });
      return response;
    }

    // Generate new token pair
    const accessToken = await signAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      firmId: user.firmId,
    });

    const newTokenRecord = await prisma.refreshToken.create({
      data: {
        token: crypto.randomUUID(),
        userId: user.id,
        expiresAt: new Date(
          Date.now() +
            parseInt(process.env.JWT_REFRESH_EXPIRY || "604800") * 1000
        ),
      },
    });

    const newRefreshToken = await signRefreshToken({
      userId: user.id,
      tokenId: newTokenRecord.id,
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
    response.headers.append("Set-Cookie", getRefreshCookie(newRefreshToken));

    return response;
  } catch (error) {
    console.error("Refresh error:", error);
    return internalError();
  }
}
