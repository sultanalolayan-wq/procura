import Link from "next/link";
import { ButtonLink, Card, PageHeader, Stat, StatusBadge, Table } from "@/components/ui";
import { formatCurrency, formatDate } from "@/lib/format";
import { listOrders, listRequests, listSuppliers } from "@/lib/store";
import { lineItemsTotal } from "@/lib/types";

// Reads mutable in-process state, so it must render per request.
export const dynamic = "force-dynamic";

export default function DashboardPage() {
  const requests = listRequests();
  const orders = listOrders();
  const suppliers = listSuppliers();

  const pending = requests.filter((request) => request.status === "pending");
  const readyToOrder = requests.filter((request) => request.status === "approved");
  const openOrders = orders.filter((order) => order.status === "issued");
  const committed = orders
    .filter((order) => order.status !== "cancelled")
    .reduce((sum, order) => sum + lineItemsTotal(order.items), 0);

  const byDepartment = new Map<string, number>();
  for (const request of requests) {
    if (request.status === "rejected") continue;
    byDepartment.set(
      request.department,
      (byDepartment.get(request.department) ?? 0) + lineItemsTotal(request.items),
    );
  }
  const departments = [...byDepartment.entries()].sort((a, b) => b[1] - a[1]);
  const maxDepartment = departments[0]?.[1] ?? 1;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Where every request stands right now."
        action={<ButtonLink href="/requests/new">New request</ButtonLink>}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Awaiting approval" value={String(pending.length)} />
        <Stat label="Approved, not ordered" value={String(readyToOrder.length)} />
        <Stat label="Open orders" value={String(openOrders.length)} />
        <Stat label="Committed spend" value={formatCurrency(committed)} />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
            Recent requests
          </h2>
          <Table head={["Request", "Department", "Value", "Status"]}>
            {requests.slice(0, 6).map((request) => (
              <tr key={request.id}>
                <td className="px-4 py-3">
                  <Link
                    href={`/requests/${request.id}`}
                    className="font-medium hover:text-accent"
                  >
                    {request.title}
                  </Link>
                  <div className="text-xs text-muted">
                    {request.id} · raised {formatDate(request.createdAt)}
                  </div>
                </td>
                <td className="px-4 py-3 text-muted">{request.department}</td>
                <td className="px-4 py-3 tabular-nums">
                  {formatCurrency(lineItemsTotal(request.items))}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={request.status} />
                </td>
              </tr>
            ))}
          </Table>
        </div>

        <div className="space-y-6">
          <Card title="Request value by department">
            <ul className="space-y-3">
              {departments.map(([department, total]) => (
                <li key={department}>
                  <div className="flex justify-between text-sm">
                    <span>{department}</span>
                    <span className="tabular-nums text-muted">
                      {formatCurrency(total)}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-accent/10">
                    <div
                      className="h-full rounded-full bg-accent"
                      style={{ width: `${Math.round((total / maxDepartment) * 100)}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Suppliers">
            <p className="text-sm text-muted">
              {suppliers.filter((supplier) => supplier.status === "active").length} active
              of {suppliers.length} on record.
            </p>
            <div className="mt-4">
              <ButtonLink href="/suppliers" variant="ghost">
                Manage suppliers
              </ButtonLink>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
