"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createOrder,
  createRequest,
  createSupplier,
  decideRequest,
  setOrderStatus,
} from "./store";
import type { LineItem, OrderStatus, SupplierStatus } from "./types";

export type FormState = { error?: string };

const text = (data: FormData, key: string): string =>
  String(data.get(key) ?? "").trim();

const parseLineItems = (data: FormData): LineItem[] => {
  const descriptions = data.getAll("itemDescription").map(String);
  const quantities = data.getAll("itemQuantity").map(String);
  const prices = data.getAll("itemUnitPrice").map(String);

  return descriptions
    .map((description, index) => ({
      description: description.trim(),
      quantity: Number(quantities[index] ?? 0),
      unitPrice: Number(prices[index] ?? 0),
    }))
    .filter((item) => item.description.length > 0);
};

export async function createSupplierAction(
  _prev: FormState,
  data: FormData,
): Promise<FormState> {
  const name = text(data, "name");
  const contactEmail = text(data, "contactEmail");
  if (!name) return { error: "Supplier name is required." };
  if (!contactEmail.includes("@")) return { error: "A valid contact email is required." };

  createSupplier({
    name,
    category: text(data, "category") || "Uncategorised",
    contactName: text(data, "contactName"),
    contactEmail,
    paymentTerms: text(data, "paymentTerms") || "Net 30",
    status: (text(data, "status") as SupplierStatus) || "active",
  });

  revalidatePath("/suppliers");
  return {};
}

export async function createRequestAction(
  _prev: FormState,
  data: FormData,
): Promise<FormState> {
  const title = text(data, "title");
  const requester = text(data, "requester");
  const items = parseLineItems(data);

  if (!title) return { error: "Give the request a short title." };
  if (!requester) return { error: "Requester name is required." };
  if (items.length === 0) return { error: "Add at least one line item." };
  if (items.some((item) => item.quantity <= 0 || item.unitPrice < 0)) {
    return { error: "Line items need a quantity above zero and a non-negative price." };
  }

  const request = createRequest({
    title,
    requester,
    department: text(data, "department") || "Unassigned",
    justification: text(data, "justification"),
    neededBy: text(data, "neededBy"),
    items,
  });

  revalidatePath("/requests");
  revalidatePath("/");
  redirect(`/requests/${request.id}`);
}

export async function decideRequestAction(data: FormData): Promise<void> {
  const id = text(data, "id");
  const decision = text(data, "decision");
  if (decision !== "approved" && decision !== "rejected") return;

  decideRequest(id, decision, text(data, "note"));
  revalidatePath(`/requests/${id}`);
  revalidatePath("/requests");
  revalidatePath("/");
}

export async function createOrderAction(
  _prev: FormState,
  data: FormData,
): Promise<FormState> {
  const requestId = text(data, "requestId");
  const supplierId = text(data, "supplierId");
  const expectedAt = text(data, "expectedAt");

  if (!supplierId) return { error: "Choose a supplier before issuing the order." };
  if (!expectedAt) return { error: "Set an expected delivery date." };

  const order = createOrder(requestId, supplierId, expectedAt);
  if (!order) return { error: "Only approved requests can be turned into an order." };

  revalidatePath(`/requests/${requestId}`);
  revalidatePath("/requests");
  revalidatePath("/orders");
  revalidatePath("/");
  redirect(`/orders/${order.id}`);
}

export async function setOrderStatusAction(data: FormData): Promise<void> {
  const id = text(data, "id");
  const status = text(data, "status") as OrderStatus;
  if (!["issued", "received", "cancelled"].includes(status)) return;

  setOrderStatus(id, status);
  revalidatePath(`/orders/${id}`);
  revalidatePath("/orders");
  revalidatePath("/");
}
