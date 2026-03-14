import { Role } from "@prisma/client";

export interface AuthUser {
  userId: string;
  email: string;
  role: Role;
  firmId: string | null;
  firstName: string;
  lastName: string;
  firmName: string | null;
}
