// Company detail — shows full profile, score, contacts, and agent results for one company.
interface Props {
  params: { id: string };
}

export default function CompanyDetailPage({ params }: Props) {
  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Company Detail</h1>
      <p className="text-gray-500">Company ID: {params.id}</p>
    </div>
  );
}
