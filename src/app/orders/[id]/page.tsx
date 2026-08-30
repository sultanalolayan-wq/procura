import Link from "next/link";
import { notFound } from "next/navigation";
import { SubmitButton } from "@/components/forms";
import { Card, PageHeader, StatusBadge } from "@/components/ui";
import { setOrderStatusAction } from "@/lib/actions";
import { formatCurrency, formatDate } from "@/lib/format";
import { getOrder, getRequest, getSupplier } from "@/lib/store";
import { lineItemsTotal } from "@/lib/types";

export default async function OrderDetailPage({ params }: PageProps<"/orders/[id]">) {
  const { id } = await params;
  const order = getOrder(id);
  if (!order) notFound();

  const supplier = getSupplier(order.supplierId);
  const request = getRequest(order.requestId);

  return (
    <>
      <PageHeader
        title={`Order ${order.id}`}
        description={`Issued ${formatDate(order.issuedAt)} · expected ${formatDate(order.expectedAt)}`}
        action={<StatusBadge status={order.status} />}
      />

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card title="Ordered items">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="py-2 font-medium">Description</th>
                <th className="py-2 text-right font-medium">Qty</th>
                <th className="py-2 text-right font-medium">Unit</th>
                <th className="py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {order.items.map((item, index) => (
                <tr key={`${item.description}-${index}`}>
                  <td className="py-2.5 pr-4">{item.description}</td>
                  <td className="py-2.5 text-right tabular-nums">{item.quantity}</td>
                  <td className="py-2.5 text-right tabular-nums">
                    {formatCurrency(item.unitPrice)}
                  </td>
                  <td className="py-2.5 text-right tabular-nums">
                    {formatCurrency(item.quantity * item.unitPrice)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-line font-semibold">
                <td className="py-3" colSpan={3}>
                  Total
                </td>
                <td className="py-3 text-right tabular-nums">
                  {formatCurrency(lineItemsTotal(order.items))}
                </td>
              </tr>
            </tfoot>
          </table>
        </Card>

        <div className="space-y-6">
          <Card title="Supplier">
            <p className="text-sm font-medium">{supplier?.name ?? "Unknown supplier"}</p>
            <p className="text-sm text-muted">
              {supplier?.contactName} · {supplier?.contactEmail}
            </p>
            <p className="mt-2 text-sm text-muted">Terms: {supplier?.paymentTerms}</p>
          </Card>

          <Card title="Source request">
            {request ? (
              <Link
                href={`/requests/${request.id}`}
                className="text-sm font-medium hover:text-accent"
              >
                {request.id} — {request.title}
              </Link>
            ) : (
              <p className="text-sm text-muted">Request not found.</p>
            )}
          </Card>

          {order.status === "issued" ? (
            <Card title="Update status">
              <form action={setOrderStatusAction} className="flex gap-2">
                <input type="hidden" name="id" value={order.id} />
                <SubmitButton name="status" value="received">
                  Mark received
                </SubmitButton>
                <SubmitButton name="status" value="cancelled" variant="danger">
                  Cancel
                </SubmitButton>
              </form>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
