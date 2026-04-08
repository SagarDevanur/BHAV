"use client";

import { UserButton, useUser } from "@clerk/nextjs";

export function UserHeader() {
  const { user, isLoaded } = useUser();

  return (
    <div className="flex items-center gap-3">
      {isLoaded && user ? (
        <span className="text-sm font-medium text-gray-700">
          {user.fullName ?? user.primaryEmailAddress?.emailAddress}
        </span>
      ) : (
        // Skeleton while Clerk loads
        <span className="h-4 w-32 animate-pulse rounded bg-gray-200" />
      )}
      <UserButton afterSignOutUrl="/sign-in" />
    </div>
  );
}
