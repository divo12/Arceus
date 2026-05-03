import { NextRequest, NextResponse } from "next/server";

const PROTECTED = [
  "/home",
  "/dashboard",
  "/tasks",
  "/inbox",
  "/inspector",
  "/agents",
  "/logs",
  "/execution",
  "/governance",
  "/preview",
  "/meetings",
  "/meetings-viz",
  "/settings",
  "/employees",
  "/debug",
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isProtected = PROTECTED.some((p) => pathname === p || pathname.startsWith(p + "/"));

  if (isProtected && req.cookies.get("arceus_auth")?.value !== "1") {
    return NextResponse.redirect(new URL("/?login=1", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/).*)",
  ],
};
