import Link from "next/link";
import { ButtonLink, EmptyState, PageHeader, StatusBadge, Table } from "@/components/ui";
import { formatCurrency, formatDate } from "@/lib/format";
import { listRequests } from "@/lib/store";
import { lineItemsTotal, type RequestStatus } from "@/lib/types";

const filters: { value: RequestStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "ordered", label: "Ordered" },
  { value: "rejected", label: "Rejected" },
];

export default async function RequestsPage({ searchParams }: PageProps<"/requests">) {
  const { status } = await searchParams;
  const active = typeof status === "string" ? status : "all";
  const requests = listRequests().filter(
    (request) => active === "all" || request.status === active,
  );

  return (
    <>
      <PageHeader
        title="Purchase requests"
        description="Everything raised by the business, newest first."
        action={<ButtonLink href="/requests/new">New request</ButtonLink>}
      />

      <div className="mb-5 flex flex-wrap gap-2">
        {filters.map((filter) => (
          <Link
            key={filter.value}
            href={filter.value === "all" ? "/requests" : `/requests?status=${filter.value}`}
            className={`rounded-full border px-3 py-1 text-sm transition ${
              active === filter.value
                ? "border-accent bg-accent/10 text-accent"
                : "border-line text-muted hover:text-foreground"
            }`}
          >
            {filter.label}
          </Link>
        ))}
      </div>

      {requests.length === 0 ? (
        <EmptyState>No requests match this filter.</EmptyState>
      ) : (
        <Table head={["Request", "Requester", "Needed by", "Value", "Status"]}>
          {requests.map((request) => (
            <tr key={request.id}>
              <td className="px-4 py-3">
                <Link
                  href={`/requests/${request.id}`}
                  className="font-medium hover:text-accent"
                >
                  {request.title}
                </Link>
                <div className="text-xs text-muted">
                  {request.id} · {request.department}
                </div>
              </td>
              <td className="px-4 py-3 text-muted">{request.requester}</td>
              <td className="px-4 py-3 text-muted">
                {request.neededBy ? formatDate(request.neededBy) : "—"}
              </td>
              <td className="px-4 py-3 tabular-nums">
                {formatCurrency(lineItemsTotal(request.items))}
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={request.status} />
              </td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
