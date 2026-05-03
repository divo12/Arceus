import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { getDb } from "@arceus/db/src/client";
import { findUserByEmail } from "@arceus/db/src/repos/users";

export async function POST(req: Request) {
  let email: string, password: string;
  try {
    ({ email, password } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!email || !password) {
    return NextResponse.json({ error: "Missing credentials" }, { status: 400 });
  }

  const db = getDb();
  const user = await findUserByEmail(db, email.toLowerCase().trim());

  const invalid = !user?.passwordHash || !(await bcrypt.compare(password, user.passwordHash));
  if (invalid) {
    return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set("arceus_auth", "1", { path: "/", maxAge: 86400 });
  return res;
}
