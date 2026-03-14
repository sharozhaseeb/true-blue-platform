import { Role } from "@prisma/client";

type Permission =
  | "manage_firms"
  | "manage_all_users"
  | "manage_firm_users"
  | "view_firm_data"
  | "upload_documents"
  | "query_documents";

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  PLATFORM_ADMIN: [
    "manage_firms",
    "manage_all_users",
    "manage_firm_users",
    "view_firm_data",
    "upload_documents",
    "query_documents",
  ],
  FIRM_ADMIN: [
    "manage_firm_users",
    "view_firm_data",
    "upload_documents",
    "query_documents",
  ],
  FIRM_USER: ["view_firm_data", "upload_documents", "query_documents"],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
