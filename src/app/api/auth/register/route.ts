import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword, validatePassword } from "@/lib/password";
import {
  signAccessToken,
  signRefreshToken,
  getAccessCookie,
  getRefreshCookie,
} from "@/lib/auth";
import { badRequest, conflict, internalError } from "@/lib/errors";

export async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return badRequest("Invalid JSON body");
    }
    const { email, password, firstName, lastName, firmSlug } = body;

    // Validate required fields
    if (!email || !password || !firstName || !lastName || !firmSlug) {
      return badRequest(
        "Email, password, first name, last name, and firm code are required"
      );
    }

    // Input length validation
    if (email.length > 254) return badRequest("Email is too long");
    if (firstName.length > 100) return badRequest("First name is too long");
    if (lastName.length > 100) return badRequest("Last name is too long");
    if (firmSlug.length > 100) return badRequest("Firm code is too long");
    if (password.length > 72)
      return badRequest("Password must be 72 characters or fewer");

    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return badRequest("Invalid email format");
    }

    // Validate password strength
    const passwordCheck = validatePassword(password);
    if (!passwordCheck.valid) {
      return badRequest(passwordCheck.message!);
    }

    // Check if email already exists
    // Note: This reveals whether an email is registered (email enumeration).
    // Accepted tradeoff for UX — users need to know if their email is already in use.
    // For higher security, return a generic message for all registration failures.
    const existingUser = await prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });
    if (existingUser) {
      return conflict("Email already registered");
    }

    // Find the firm by slug
    const firm = await prisma.firm.findUnique({
      where: { slug: firmSlug.trim().toLowerCase() },
    });
    if (!firm || !firm.isActive) {
      return badRequest("Invalid or inactive firm code");
    }

    // Create user
    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: {
        email: email.trim().toLowerCase(),
        passwordHash,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        role: "FIRM_USER",
        firmId: firm.id,
      },
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

    // Set cookies and return user info
    const response = NextResponse.json(
      {
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          firmId: user.firmId,
          firmName: firm.name,
        },
      },
      { status: 201 }
    );

    response.headers.append("Set-Cookie", getAccessCookie(accessToken));
    response.headers.append("Set-Cookie", getRefreshCookie(refreshToken));

    return response;
  } catch (error) {
    console.error("Registration error:", error);
    return internalError();
  }
}
