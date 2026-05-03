import { NextRequest, NextResponse } from "next/server";

const APEX = "arceus.sh";
const APP_HOST = "app.arceus.sh";

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
  const host = (req.headers.get("host") || "").toLowerCase();
  const url = req.nextUrl.clone();

  if (host === APP_HOST) {
    if (url.pathname === "/" && !url.searchParams.has("login")) {
      url.pathname = "/home";
      return NextResponse.redirect(url);
    }
  } else if (host === APEX || host === `www.${APEX}`) {
    if (url.pathname !== "/") {
      const redirect = url.clone();
      redirect.host = APP_HOST;
      return NextResponse.redirect(redirect);
    }
    return NextResponse.next();
  }

  const isProtected = PROTECTED.some(
    (p) => url.pathname === p || url.pathname.startsWith(p + "/"),
  );

  if (isProtected && req.cookies.get("arceus_auth")?.value !== "1") {
    return NextResponse.redirect(new URL("/?login=1", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/).*)"],
};
