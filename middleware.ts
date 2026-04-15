import { validateWebConfig } from "@/lib/config";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Validate all required environment variables once at Next.js startup.
validateWebConfig();

// Public routes — no authentication required.
// /unauthorized is public so unauthenticated users (or users on wrong accounts)
// can see the access-restricted message without a redirect loop.
const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/unauthorized",
  "/api/webhooks(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    // Redirect to /sign-in if the user is not authenticated.
    // Email-domain access control is enforced in app/(dashboard)/layout.tsx
    // using currentUser(), which avoids a clerkClient API call in middleware.
    await auth().protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
