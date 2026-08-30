import Link from "next/link";
import { notFound } from "next/navigation";
import { OrderForm, SubmitButton } from "@/components/forms";
import { Card, PageHeader, StatusBadge, fieldClass } from "@/components/ui";
import { decideRequestAction } from "@/lib/actions";
import { formatCurrency, formatDate } from "@/lib/format";
import { getOrderForRequest, getRequest, listSuppliers } from "@/lib/store";
import { lineItemsTotal } from "@/lib/types";

export default async function RequestDetailPage({
  params,
}: PageProps<"/requests/[id]">) {
  const { id } = await params;
  const request = getRequest(id);
  if (!request) notFound();

  const order = getOrderForRequest(request.id);
  const suppliers = listSuppliers().filter((supplier) => supplier.status === "active");
  const total = lineItemsTotal(request.items);

  return (
    <>
      <PageHeader
        title={request.title}
        description={`${request.id} · raised by ${request.requester} (${request.department}) on ${formatDate(request.createdAt)}`}
        action={<StatusBadge status={request.status} />}
      />

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <Card title="Line items">
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
                {request.items.map((item, index) => (
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
                    {formatCurrency(total)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </Card>

          {request.status === "approved" ? (
            <Card title="Issue a purchase order">
              <OrderForm requestId={request.id} suppliers={suppliers} />
            </Card>
          ) : null}

          {order ? (
            <Card title="Purchase order">
              <p className="text-sm">
                <Link href={`/orders/${order.id}`} className="font-medium hover:text-accent">
                  {order.id}
                </Link>{" "}
                <span className="text-muted">
                  issued {formatDate(order.issuedAt)} · expected{" "}
                  {formatDate(order.expectedAt)}
                </span>
              </p>
            </Card>
          ) : null}
        </div>

        <div className="space-y-6">
          <Card title="Details">
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-muted">Needed by</dt>
                <dd>{request.neededBy ? formatDate(request.neededBy) : "Not specified"}</dd>
              </div>
              <div>
                <dt className="text-muted">Justification</dt>
                <dd>{request.justification || "—"}</dd>
              </div>
              {request.decisionNote ? (
                <div>
                  <dt className="text-muted">Decision note</dt>
                  <dd>{request.decisionNote}</dd>
                </div>
              ) : null}
            </dl>
          </Card>

          {request.status === "pending" ? (
            <Card title="Approval">
              <form action={decideRequestAction} className="space-y-3">
                <input type="hidden" name="id" value={request.id} />
                <textarea
                  name="note"
                  rows={3}
                  className={fieldClass}
                  placeholder="Optional note for the requester."
                />
                <div className="flex gap-2">
                  <SubmitButton name="decision" value="approved">
                    Approve
                  </SubmitButton>
                  <SubmitButton name="decision" value="rejected" variant="danger">
                    Reject
                  </SubmitButton>
                </div>
              </form>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
