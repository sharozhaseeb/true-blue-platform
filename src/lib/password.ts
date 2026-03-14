import bcrypt from "bcrypt";

const SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function validatePassword(password: string): {
  valid: boolean;
  message?: string;
} {
  if (password.length < 8)
    return { valid: false, message: "Password must be at least 8 characters" };
  if (!/[A-Z]/.test(password))
    return {
      valid: false,
      message: "Password must contain an uppercase letter",
    };
  if (!/[a-z]/.test(password))
    return {
      valid: false,
      message: "Password must contain a lowercase letter",
    };
  if (!/[0-9]/.test(password))
    return { valid: false, message: "Password must contain a number" };
  return { valid: true };
}
