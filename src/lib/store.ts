import type { PurchaseOrder, PurchaseRequest, Supplier } from "./types";

/**
 * In-memory data store with seed data.
 *
 * State lives on `globalThis` so it survives dev-server hot reloads. It resets
 * whenever the server process restarts — replace this module with a real
 * database layer (same function signatures) when persistence is needed.
 */
type Db = {
  suppliers: Supplier[];
  requests: PurchaseRequest[];
  orders: PurchaseOrder[];
  sequences: Record<string, number>;
};

const seed = (): Db => ({
  sequences: { SUP: 4, PR: 1005, PO: 2001 },
  suppliers: [
    {
      id: "SUP-001",
      name: "Northwind Office Supply",
      category: "Office supplies",
      contactName: "Dana Reeves",
      contactEmail: "dana@northwind.example",
      status: "active",
      paymentTerms: "Net 30",
    },
    {
      id: "SUP-002",
      name: "Helix IT Distribution",
      category: "IT hardware",
      contactName: "Marco Silva",
      contactEmail: "marco@helixit.example",
      status: "active",
      paymentTerms: "Net 45",
    },
    {
      id: "SUP-003",
      name: "Bluepine Facilities",
      category: "Facilities",
      contactName: "Priya Nair",
      contactEmail: "priya@bluepine.example",
      status: "active",
      paymentTerms: "Net 15",
    },
    {
      id: "SUP-004",
      name: "Atlas Logistics",
      category: "Logistics",
      contactName: "Sam Okoro",
      contactEmail: "sam@atlaslogistics.example",
      status: "inactive",
      paymentTerms: "Net 60",
    },
  ],
  requests: [
    {
      id: "PR-1001",
      title: "Laptops for the new analytics hires",
      requester: "Layla Haddad",
      department: "Engineering",
      justification: "Four analysts start next month and need workstations.",
      neededBy: "2026-09-20",
      status: "approved",
      createdAt: "2026-08-12",
      items: [
        { description: '14" developer laptop, 32GB RAM', quantity: 4, unitPrice: 1850 },
        { description: "USB-C docking station", quantity: 4, unitPrice: 210 },
      ],
      decisionNote: "Approved against the Q3 headcount budget.",
    },
    {
      id: "PR-1002",
      title: "Quarterly office supply restock",
      requester: "Omar Fadel",
      department: "Operations",
      justification: "Standing quarterly restock for both floors.",
      neededBy: "2026-09-05",
      status: "ordered",
      createdAt: "2026-08-14",
      items: [
        { description: "A4 paper, box of 5 reams", quantity: 25, unitPrice: 28 },
        { description: "Whiteboard marker, pack of 10", quantity: 12, unitPrice: 14.5 },
      ],
    },
    {
      id: "PR-1003",
      title: "Meeting room acoustic panels",
      requester: "Nadia Cruz",
      department: "Facilities",
      justification: "Calls in rooms 3 and 4 are unusable due to echo.",
      neededBy: "2026-10-01",
      status: "pending",
      createdAt: "2026-08-25",
      items: [{ description: "Acoustic wall panel, 60x60cm", quantity: 40, unitPrice: 46 }],
    },
    {
      id: "PR-1004",
      title: "Offsite catering for the sales kickoff",
      requester: "Tom Wexler",
      department: "Sales",
      justification: "Two-day kickoff for 60 attendees.",
      neededBy: "2026-09-12",
      status: "pending",
      createdAt: "2026-08-27",
      items: [{ description: "Full-day catering, per attendee", quantity: 120, unitPrice: 38 }],
    },
    {
      id: "PR-1005",
      title: "Standing desk conversion kits",
      requester: "Grace Lim",
      department: "Operations",
      justification: "Ergonomics follow-up from the workplace survey.",
      neededBy: "2026-11-15",
      status: "rejected",
      createdAt: "2026-08-08",
      items: [{ description: "Sit/stand desk converter", quantity: 18, unitPrice: 320 }],
      decisionNote: "Deferred to next fiscal year; no budget line this quarter.",
    },
  ],
  orders: [
    {
      id: "PO-2001",
      requestId: "PR-1002",
      supplierId: "SUP-001",
      status: "issued",
      issuedAt: "2026-08-16",
      expectedAt: "2026-09-02",
      items: [
        { description: "A4 paper, box of 5 reams", quantity: 25, unitPrice: 28 },
        { description: "Whiteboard marker, pack of 10", quantity: 12, unitPrice: 14.5 },
      ],
    },
  ],
});

const globalStore = globalThis as unknown as { __procuraDb?: Db };
const db: Db = (globalStore.__procuraDb ??= seed());

const nextId = (prefix: string): string => {
  const next = (db.sequences[prefix] = (db.sequences[prefix] ?? 0) + 1);
  return `${prefix}-${String(next).padStart(3, "0")}`;
};

export const listSuppliers = (): Supplier[] =>
  [...db.suppliers].sort((a, b) => a.name.localeCompare(b.name));

export const getSupplier = (id: string): Supplier | undefined =>
  db.suppliers.find((supplier) => supplier.id === id);

export const createSupplier = (input: Omit<Supplier, "id">): Supplier => {
  const supplier: Supplier = { ...input, id: nextId("SUP") };
  db.suppliers.push(supplier);
  return supplier;
};

export const listRequests = (): PurchaseRequest[] =>
  [...db.requests].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export const getRequest = (id: string): PurchaseRequest | undefined =>
  db.requests.find((request) => request.id === id);

export const createRequest = (
  input: Omit<PurchaseRequest, "id" | "status" | "createdAt">,
): PurchaseRequest => {
  const request: PurchaseRequest = {
    ...input,
    id: nextId("PR"),
    status: "pending",
    createdAt: new Date().toISOString().slice(0, 10),
  };
  db.requests.push(request);
  return request;
};

export const decideRequest = (
  id: string,
  decision: "approved" | "rejected",
  note: string,
): PurchaseRequest | undefined => {
  const request = getRequest(id);
  if (!request || request.status !== "pending") return undefined;
  request.status = decision;
  request.decisionNote = note || undefined;
  return request;
};

export const listOrders = (): PurchaseOrder[] =>
  [...db.orders].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));

export const getOrder = (id: string): PurchaseOrder | undefined =>
  db.orders.find((order) => order.id === id);

export const getOrderForRequest = (requestId: string): PurchaseOrder | undefined =>
  db.orders.find((order) => order.requestId === requestId);

export const createOrder = (
  requestId: string,
  supplierId: string,
  expectedAt: string,
): PurchaseOrder | undefined => {
  const request = getRequest(requestId);
  const supplier = getSupplier(supplierId);
  if (!request || !supplier || request.status !== "approved") return undefined;

  const order: PurchaseOrder = {
    id: nextId("PO"),
    requestId,
    supplierId,
    status: "issued",
    issuedAt: new Date().toISOString().slice(0, 10),
    expectedAt,
    items: request.items.map((item) => ({ ...item })),
  };
  db.orders.push(order);
  request.status = "ordered";
  return order;
};

export const setOrderStatus = (
  id: string,
  status: PurchaseOrder["status"],
): PurchaseOrder | undefined => {
  const order = getOrder(id);
  if (!order) return undefined;
  order.status = status;
  return order;
};
