import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getRequestContext } from "@/lib/tenant";
import { unauthorized, internalError } from "@/lib/errors";

export async function GET() {
  try {
    const ctx = await getRequestContext();

    if (!ctx.userId) {
      return unauthorized();
    }

    const user = await prisma.user.findUnique({
      where: { id: ctx.userId },
      include: { firm: true },
    });

    if (!user) {
      return unauthorized("User not found");
    }

    return NextResponse.json({
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
  } catch (error) {
    console.error("Me error:", error);
    return internalError();
  }
}
