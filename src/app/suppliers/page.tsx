import { SupplierForm } from "@/components/forms";
import { Card, PageHeader, StatusBadge, Table } from "@/components/ui";
import { listSuppliers } from "@/lib/store";

// Reads mutable in-process state, so it must render per request.
export const dynamic = "force-dynamic";

export default function SuppliersPage() {
  const suppliers = listSuppliers();

  return (
    <>
      <PageHeader
        title="Suppliers"
        description="The vendors an approved request can be ordered from."
      />

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Table head={["Supplier", "Category", "Contact", "Terms", "Status"]}>
          {suppliers.map((supplier) => (
            <tr key={supplier.id}>
              <td className="px-4 py-3">
                <div className="font-medium">{supplier.name}</div>
                <div className="text-xs text-muted">{supplier.id}</div>
              </td>
              <td className="px-4 py-3 text-muted">{supplier.category}</td>
              <td className="px-4 py-3 text-muted">
                {supplier.contactName ? `${supplier.contactName} · ` : ""}
                {supplier.contactEmail}
              </td>
              <td className="px-4 py-3 text-muted">{supplier.paymentTerms}</td>
              <td className="px-4 py-3">
                <StatusBadge status={supplier.status} />
              </td>
            </tr>
          ))}
        </Table>

        <Card title="Add a supplier">
          <SupplierForm />
        </Card>
      </div>
    </>
  );
}
