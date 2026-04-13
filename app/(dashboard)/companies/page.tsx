// Company list — server component fetches data with the admin client (bypasses RLS),
// then passes it to the interactive client component.
//
// force-dynamic: opts out of Next.js full route cache and data cache so the
// Supabase query runs on every request. revalidate: 0 reinforces the same.
// The client-side router cache is busted via router.refresh() in CompaniesView.
import { createAdminClient } from "@/lib/supabase/admin";
import { CompaniesView } from "@/components/dashboard/companies-view";
import type { CompanyWithContacts } from "@/components/dashboard/companies-view";

export const dynamic   = "force-dynamic";
export const revalidate = 0;

async function getCompanies(): Promise<CompanyWithContacts[]> {
  const supabase = createAdminClient();

  try {
    const { data, error } = await supabase
      .from("companies")
      .select("*, contacts(*)")
      .order("despac_score", { ascending: false, nullsFirst: false });

    if (error) throw error;

    return (data ?? []).map((row) => ({
      ...row,
      contacts: Array.isArray(row.contacts) ? row.contacts : [],
    })) as CompanyWithContacts[];
  } catch (err) {
    console.error("Failed to fetch companies:", err);
    return [];
  }
}

export default async function CompaniesPage() {
  const companies = await getCompanies();
  return <CompaniesView initialCompanies={companies} />;
}
