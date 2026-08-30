"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  createOrderAction,
  createRequestAction,
  createSupplierAction,
  type FormState,
} from "@/lib/actions";
import type { Supplier } from "@/lib/types";
import { Field, fieldClass } from "./ui";

const empty: FormState = {};

export function SubmitButton({
  children,
  variant = "primary",
  name,
  value,
}: {
  children: React.ReactNode;
  variant?: "primary" | "ghost" | "danger";
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();
  const styles = {
    primary: "bg-accent text-white",
    ghost: "border border-line",
    danger: "border border-rose-500/40 text-rose-600 dark:text-rose-300",
  }[variant];

  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={pending}
      className={`inline-flex items-center rounded-lg px-4 py-2 text-sm font-medium transition disabled:opacity-50 ${styles}`}
    >
      {pending ? "Working…" : children}
    </button>
  );
}

function ErrorText({ state }: { state: FormState }) {
  if (!state.error) return null;
  return (
    <p
      role="alert"
      className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-300"
    >
      {state.error}
    </p>
  );
}

export function SupplierForm() {
  const [state, action] = useActionState(createSupplierAction, empty);

  return (
    <form action={action} className="space-y-4">
      <ErrorText state={state} />
      <Field label="Supplier name">
        <input name="name" required className={fieldClass} placeholder="Acme Trading" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Category">
          <input name="category" className={fieldClass} placeholder="IT hardware" />
        </Field>
        <Field label="Payment terms">
          <input name="paymentTerms" className={fieldClass} placeholder="Net 30" />
        </Field>
        <Field label="Contact name">
          <input name="contactName" className={fieldClass} placeholder="Jane Doe" />
        </Field>
        <Field label="Contact email">
          <input
            name="contactEmail"
            type="email"
            required
            className={fieldClass}
            placeholder="jane@acme.example"
          />
        </Field>
      </div>
      <Field label="Status">
        <select name="status" className={fieldClass} defaultValue="active">
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </Field>
      <SubmitButton>Add supplier</SubmitButton>
    </form>
  );
}

export function RequestForm() {
  const [state, action] = useActionState(createRequestAction, empty);
  const [rows, setRows] = useState([0]);

  return (
    <form action={action} className="space-y-5">
      <ErrorText state={state} />
      <Field label="Title">
        <input
          name="title"
          required
          className={fieldClass}
          placeholder="Laptops for the design team"
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Requester">
          <input name="requester" required className={fieldClass} />
        </Field>
        <Field label="Department">
          <input name="department" className={fieldClass} placeholder="Engineering" />
        </Field>
        <Field label="Needed by">
          <input name="neededBy" type="date" className={fieldClass} />
        </Field>
      </div>
      <Field label="Justification">
        <textarea
          name="justification"
          rows={3}
          className={fieldClass}
          placeholder="Why this purchase is needed."
        />
      </Field>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium">Line items</span>
          <button
            type="button"
            onClick={() => setRows((current) => [...current, Date.now()])}
            className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium"
          >
            Add item
          </button>
        </div>
        <div className="space-y-3">
          {rows.map((row, index) => (
            <div key={row} className="grid gap-3 sm:grid-cols-[1fr_7rem_9rem_auto]">
              <input
                name="itemDescription"
                required
                className={fieldClass}
                placeholder="Description"
                aria-label={`Item ${index + 1} description`}
              />
              <input
                name="itemQuantity"
                type="number"
                min={1}
                defaultValue={1}
                className={fieldClass}
                aria-label={`Item ${index + 1} quantity`}
              />
              <input
                name="itemUnitPrice"
                type="number"
                min={0}
                step="0.01"
                defaultValue={0}
                className={fieldClass}
                aria-label={`Item ${index + 1} unit price`}
              />
              <button
                type="button"
                onClick={() => setRows((current) => current.filter((r) => r !== row))}
                disabled={rows.length === 1}
                className="rounded-lg border border-line px-3 py-2 text-xs disabled:opacity-40"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      </div>

      <SubmitButton>Submit request</SubmitButton>
    </form>
  );
}

export function OrderForm({
  requestId,
  suppliers,
}: {
  requestId: string;
  suppliers: Supplier[];
}) {
  const [state, action] = useActionState(createOrderAction, empty);

  return (
    <form action={action} className="space-y-4">
      <ErrorText state={state} />
      <input type="hidden" name="requestId" value={requestId} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Supplier">
          <select name="supplierId" className={fieldClass} defaultValue="">
            <option value="" disabled>
              Select a supplier
            </option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name} — {supplier.paymentTerms}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Expected delivery">
          <input name="expectedAt" type="date" className={fieldClass} />
        </Field>
      </div>
      <SubmitButton>Issue purchase order</SubmitButton>
    </form>
  );
}
