// Singleton refresh promise — prevents concurrent 401s from triggering
// multiple refresh calls (token rotation would invalidate the second)
let refreshPromise: Promise<boolean> | null = null;

async function refreshToken(): Promise<boolean> {
  const res = await fetch("/api/auth/refresh", {
    method: "POST",
    credentials: "include",
  });
  return res.ok;
}

async function ensureRefreshed(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = refreshToken().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export async function fetchWithAuth(
  url: string,
  options?: RequestInit
): Promise<Response> {
  let res = await fetch(url, { ...options, credentials: "include" });

  if (res.status === 401) {
    const refreshed = await ensureRefreshed();

    if (refreshed) {
      res = await fetch(url, { ...options, credentials: "include" });
    }
  }

  return res;
}
