export type SupplierStatus = "active" | "inactive";

export type Supplier = {
  id: string;
  name: string;
  category: string;
  contactName: string;
  contactEmail: string;
  status: SupplierStatus;
  paymentTerms: string;
};

export type LineItem = {
  description: string;
  quantity: number;
  unitPrice: number;
};

export type RequestStatus = "pending" | "approved" | "rejected" | "ordered";

export type PurchaseRequest = {
  id: string;
  title: string;
  requester: string;
  department: string;
  justification: string;
  neededBy: string;
  status: RequestStatus;
  createdAt: string;
  items: LineItem[];
  decisionNote?: string;
};

export type OrderStatus = "issued" | "received" | "cancelled";

export type PurchaseOrder = {
  id: string;
  requestId: string;
  supplierId: string;
  status: OrderStatus;
  issuedAt: string;
  expectedAt: string;
  items: LineItem[];
};

export const lineItemsTotal = (items: LineItem[]): number =>
  items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
