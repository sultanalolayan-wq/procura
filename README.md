# Procura

A lightweight procurement app: raise purchase requests, approve or reject them,
turn approved requests into purchase orders, and keep a supplier list.

Built with Next.js (App Router), React Server Components, server actions,
TypeScript, and Tailwind CSS.

## Getting started

```bash
npm install
npm run dev      # http://localhost:3000
```

Other scripts: `npm run build`, `npm run start`, `npm run lint`.

## What's in it

| Route             | Purpose                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `/`               | Dashboard — open approvals, orders, committed spend, spend by department |
| `/requests`       | All purchase requests, filterable by status                          |
| `/requests/new`   | Raise a request with any number of line items                        |
| `/requests/[id]`  | Request detail, approve/reject, issue a purchase order               |
| `/orders`         | All purchase orders                                                  |
| `/orders/[id]`    | Order detail, mark received or cancel                                |
| `/suppliers`      | Supplier list and add-supplier form                                  |

### Workflow

```
request (pending) ──approve──> approved ──issue PO──> ordered ──> PO received / cancelled
        └────────reject──────> rejected
```

A request can only be approved or rejected while it is `pending`, and only an
`approved` request can be turned into a purchase order. Mutations run as server
actions in `src/lib/actions.ts` and re-render the affected pages.

## Data

Data lives in an in-memory store (`src/lib/store.ts`) seeded with demo suppliers,
requests, and one order. **It resets when the server process restarts.** The
module exposes a small set of functions (`listRequests`, `createOrder`,
`decideRequest`, …) — swap its body for real database calls and the rest of the
app is unchanged.

## Layout

```
src/
  app/          routes (server components)
  components/   nav, UI primitives, client forms
  lib/          types, formatting, store, server actions
```
