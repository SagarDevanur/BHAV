// Company list — server component fetches data with the admin client (bypasses RLS),
// then passes it to the interactive client component.
import { createAdminClient } from "@/lib/supabase/admin";
import { CompaniesView } from "@/components/dashboard/companies-view";
import type { CompanyWithContacts } from "@/components/dashboard/companies-view";

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
