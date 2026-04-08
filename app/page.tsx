// Root redirect — authenticated users go to the dashboard, everyone else to sign-in.
// The middleware also enforces auth, but this ensures a clean redirect even if
// the middleware matcher misses the root path.
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

export default function RootPage() {
  const { userId } = auth();
  redirect(userId ? "/dashboard" : "/sign-in");
}
