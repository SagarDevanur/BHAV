import { validateWebConfig } from "@/lib/config";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Validate all required environment variables once at Next.js startup.
// Throws immediately with a clear list of missing vars rather than failing
// mid-request with a cryptic undefined error.
validateWebConfig();

const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",       // shows "contact admin" — still public so unauthenticated users see it
  "/api/webhooks(.*)",  // Clerk webhook endpoint must be reachable without a session
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth().protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
