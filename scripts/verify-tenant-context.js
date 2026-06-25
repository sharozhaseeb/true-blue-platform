#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

process.env.JWT_ACCESS_SECRET ||= "tenant-context-test-access-secret";
process.env.JWT_REFRESH_SECRET ||= "tenant-context-test-refresh-secret";

const path = require("path");
const Module = require("module");

const repoRoot = path.resolve(__dirname, "..");

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function patchedResolve(
  request,
  parent,
  isMain,
  options
) {
  if (request.startsWith("@/")) {
    request = path.join(repoRoot, "src", request.slice(2));
  }

  return originalResolveFilename.call(this, request, parent, isMain, options);
};

const tsNode = require(path.join(repoRoot, "node_modules", "ts-node"));
tsNode.register({
  transpileOnly: true,
  compilerOptions: {
    module: "commonjs",
    moduleResolution: "node",
    esModuleInterop: true,
  },
});

const { signAccessToken } = require(path.join(repoRoot, "src/lib/auth.ts"));
const { signRefreshToken } = require(path.join(repoRoot, "src/lib/auth.ts"));
const {
  resolveRequestContextFromAccessToken,
  enforceTenantAccess,
} = require(path.join(repoRoot, "src/lib/tenant.ts"));

function assertCondition(condition, message, failures) {
  if (!condition) {
    failures.push(message);
  }
}

function createDb(users, calls) {
  return {
    user: {
      async findUnique(args) {
        calls.push(args);
        return users[args.where.id] ?? null;
      },
    },
  };
}

async function main() {
  const failures = [];
  const calls = [];
  const users = {
    activeUser: {
      id: "activeUser",
      role: "FIRM_USER",
      firmId: "firm_active",
      isActive: true,
      firm: { id: "firm_active", isActive: true },
    },
    inactiveUser: {
      id: "inactiveUser",
      role: "FIRM_USER",
      firmId: "firm_active",
      isActive: false,
      firm: { id: "firm_active", isActive: true },
    },
    inactiveFirmUser: {
      id: "inactiveFirmUser",
      role: "FIRM_ADMIN",
      firmId: "firm_inactive",
      isActive: true,
      firm: { id: "firm_inactive", isActive: false },
    },
    platformAdmin: {
      id: "platformAdmin",
      role: "PLATFORM_ADMIN",
      firmId: null,
      isActive: true,
      firm: null,
    },
    badPlatformAdmin: {
      id: "badPlatformAdmin",
      role: "PLATFORM_ADMIN",
      firmId: "firm_active",
      isActive: true,
      firm: { id: "firm_active", isActive: true },
    },
  };
  const db = createDb(users, calls);

  const missingTokenCtx = await resolveRequestContextFromAccessToken(undefined, db);
  assertCondition(
    !missingTokenCtx.isAuthenticated &&
      missingTokenCtx.role === null &&
      calls.length === 0,
    "missing token should not authenticate, expose a role, or query DB",
    failures
  );

  const activeUserToken = await signAccessToken({
    userId: "activeUser",
    email: "user@example.test",
    role: "PLATFORM_ADMIN",
    firmId: "spoofed_firm",
  });
  const activeUserCtx = await resolveRequestContextFromAccessToken(
    activeUserToken,
    db
  );
  assertCondition(
    activeUserCtx.isAuthenticated &&
      activeUserCtx.userId === "activeUser" &&
      activeUserCtx.role === "FIRM_USER" &&
      activeUserCtx.firmId === "firm_active",
    "context should use active DB user role/firm instead of token role/firm",
    failures
  );
  assertCondition(
    enforceTenantAccess(activeUserCtx, "firm_active") &&
      !enforceTenantAccess(activeUserCtx, "other_firm"),
    "firm user tenant access was not enforced",
    failures
  );

  const inactiveUserToken = await signAccessToken({
    userId: "inactiveUser",
    email: "inactive@example.test",
    role: "FIRM_USER",
    firmId: "firm_active",
  });
  const inactiveUserCtx = await resolveRequestContextFromAccessToken(
    inactiveUserToken,
    db
  );
  assertCondition(
    !inactiveUserCtx.isAuthenticated,
    "inactive users should not authenticate",
    failures
  );

  const inactiveFirmToken = await signAccessToken({
    userId: "inactiveFirmUser",
    email: "inactive-firm@example.test",
    role: "FIRM_ADMIN",
    firmId: "firm_inactive",
  });
  const inactiveFirmCtx = await resolveRequestContextFromAccessToken(
    inactiveFirmToken,
    db
  );
  assertCondition(
    !inactiveFirmCtx.isAuthenticated,
    "firm-scoped users in inactive firms should not authenticate",
    failures
  );

  const platformAdminToken = await signAccessToken({
    userId: "platformAdmin",
    email: "admin@example.test",
    role: "PLATFORM_ADMIN",
    firmId: null,
  });
  const platformAdminCtx = await resolveRequestContextFromAccessToken(
    platformAdminToken,
    db
  );
  assertCondition(
    platformAdminCtx.isAuthenticated &&
      platformAdminCtx.role === "PLATFORM_ADMIN" &&
      platformAdminCtx.firmId === null &&
      enforceTenantAccess(platformAdminCtx, "any_firm"),
    "platform admin should authenticate without firm scope",
    failures
  );

  const badPlatformAdminToken = await signAccessToken({
    userId: "badPlatformAdmin",
    email: "bad-admin@example.test",
    role: "PLATFORM_ADMIN",
    firmId: "firm_active",
  });
  const badPlatformAdminCtx = await resolveRequestContextFromAccessToken(
    badPlatformAdminToken,
    db
  );
  assertCondition(
    !badPlatformAdminCtx.isAuthenticated,
    "platform admins with a firm scope should not authenticate",
    failures
  );

  const refreshToken = await signRefreshToken({
    userId: "activeUser",
    tokenId: "refresh-token-id",
  });
  const refreshAsAccessCtx = await resolveRequestContextFromAccessToken(
    refreshToken,
    db
  );
  assertCondition(
    !refreshAsAccessCtx.isAuthenticated,
    "refresh tokens should not authenticate as access tokens",
    failures
  );

  const invalidTokenCtx = await resolveRequestContextFromAccessToken(
    "not-a-valid-token",
    db
  );
  assertCondition(
    !invalidTokenCtx.isAuthenticated,
    "invalid token should not authenticate",
    failures
  );

  const throwingDbToken = await signAccessToken({
    userId: "activeUser",
    email: "user@example.test",
    role: "FIRM_USER",
    firmId: "firm_active",
  });
  try {
    await resolveRequestContextFromAccessToken(throwingDbToken, {
      user: {
        async findUnique() {
          throw new Error("database unavailable");
        },
      },
    });
    failures.push("DB errors should propagate instead of becoming anonymous auth");
  } catch (error) {
    assertCondition(
      String(error.message || error).includes("database unavailable"),
      "DB failure propagated an unexpected error",
      failures
    );
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Tenant context verified: signed token + active DB identity required");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
