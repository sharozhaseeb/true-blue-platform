import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {
  const hash = (pw: string) => bcrypt.hash(pw, 12);

  // Platform Admin (no firm)
  await prisma.user.upsert({
    where: { email: "admin@trueblue.dev" },
    update: {},
    create: {
      email: "admin@trueblue.dev",
      passwordHash: await hash("Admin123!"),
      firstName: "Platform",
      lastName: "Admin",
      role: Role.PLATFORM_ADMIN,
    },
  });

  // Firm A
  const firmA = await prisma.firm.upsert({
    where: { slug: "acme-tax" },
    update: {},
    create: { name: "Acme Tax Services", slug: "acme-tax" },
  });

  await prisma.user.upsert({
    where: { email: "admin@acmetax.com" },
    update: {},
    create: {
      email: "admin@acmetax.com",
      passwordHash: await hash("FirmAdmin1!"),
      firstName: "Alice",
      lastName: "Admin",
      role: Role.FIRM_ADMIN,
      firmId: firmA.id,
    },
  });

  await prisma.user.upsert({
    where: { email: "user@acmetax.com" },
    update: {},
    create: {
      email: "user@acmetax.com",
      passwordHash: await hash("FirmUser1!"),
      firstName: "Alice",
      lastName: "User",
      role: Role.FIRM_USER,
      firmId: firmA.id,
    },
  });

  // Firm B
  const firmB = await prisma.firm.upsert({
    where: { slug: "best-tax" },
    update: {},
    create: { name: "Best Tax Advisors", slug: "best-tax" },
  });

  await prisma.user.upsert({
    where: { email: "admin@besttax.com" },
    update: {},
    create: {
      email: "admin@besttax.com",
      passwordHash: await hash("FirmAdmin1!"),
      firstName: "Bob",
      lastName: "Admin",
      role: Role.FIRM_ADMIN,
      firmId: firmB.id,
    },
  });

  console.log("Seed complete.");
  console.log("Test accounts:");
  console.log("  Platform Admin: admin@trueblue.dev / Admin123!");
  console.log("  Firm A Admin:   admin@acmetax.com / FirmAdmin1!");
  console.log("  Firm A User:    user@acmetax.com / FirmUser1!");
  console.log("  Firm B Admin:   admin@besttax.com / FirmAdmin1!");
  console.log("Firm codes: acme-tax, best-tax");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
