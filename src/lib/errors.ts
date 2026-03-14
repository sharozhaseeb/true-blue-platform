import { NextResponse } from "next/server";

export function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ error: "Unauthorized", message }, { status: 401 });
}

export function forbidden(message = "Forbidden") {
  return NextResponse.json({ error: "Forbidden", message }, { status: 403 });
}

export function badRequest(message: string) {
  return NextResponse.json({ error: "Bad Request", message }, { status: 400 });
}

export function conflict(message: string) {
  return NextResponse.json({ error: "Conflict", message }, { status: 409 });
}

export function internalError(message = "Internal Server Error") {
  return NextResponse.json(
    { error: "Internal Server Error", message },
    { status: 500 }
  );
}
