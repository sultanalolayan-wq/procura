import Link from "next/link";
import { EmptyState, PageHeader, StatusBadge, Table } from "@/components/ui";
import { formatCurrency, formatDate } from "@/lib/format";
import { getRequest, getSupplier, listOrders } from "@/lib/store";
import { lineItemsTotal } from "@/lib/types";

// Reads mutable in-process state, so it must render per request.
export const dynamic = "force-dynamic";

export default function OrdersPage() {
  const orders = listOrders();

  return (
    <>
      <PageHeader
        title="Purchase orders"
        description="Orders raised from approved requests."
      />

      {orders.length === 0 ? (
        <EmptyState>
          No orders yet. Approve a request, then issue an order against it.
        </EmptyState>
      ) : (
        <Table head={["Order", "Supplier", "Expected", "Value", "Status"]}>
          {orders.map((order) => (
            <tr key={order.id}>
              <td className="px-4 py-3">
                <Link href={`/orders/${order.id}`} className="font-medium hover:text-accent">
                  {order.id}
                </Link>
                <div className="text-xs text-muted">
                  {getRequest(order.requestId)?.title ?? order.requestId}
                </div>
              </td>
              <td className="px-4 py-3 text-muted">
                {getSupplier(order.supplierId)?.name ?? "Unknown supplier"}
              </td>
              <td className="px-4 py-3 text-muted">{formatDate(order.expectedAt)}</td>
              <td className="px-4 py-3 tabular-nums">
                {formatCurrency(lineItemsTotal(order.items))}
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={order.status} />
              </td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
