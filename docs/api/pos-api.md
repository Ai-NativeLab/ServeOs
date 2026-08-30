# POS API Reference

This document provides a reference for the ServeOS POS (Point of Sale) API. These endpoints are primarily consumed by the Electron-based POS desktop application.

## Authentication

All POS routes require authentication using one of two methods:

- **Device Token Authentication**: Requires the device bearer token in the Authorization header.
  - Header: `Authorization: Bearer <deviceToken>`
  - Handled via: `requirePosDevice()` middleware.
- **Cashier Token Authentication**: Requires both the device token and the cashier's token.
  - Headers: `Authorization: Bearer <deviceToken>` AND `X-POS-Cashier: <cashierToken>`
  - Handled via: `requirePosCashier()` middleware.

> [!WARNING]
> Ensure device tokens are securely stored locally on the POS machine. If a device token is compromised, the device must be unpaired from the Admin Dashboard immediately.

---

## Device & Auth Endpoints

### POST /api/pos/v1/pair

Pairs a new POS device using a short-lived pairing code generated from the Admin Dashboard.

- **Auth**: None (Public)
- **Request Body**:
  ```typescript
  {
    pairingCode: string;
    hardwareId: string;
    deviceName: string;
  }
  ```
- **Response**:
  ```typescript
  {
    deviceToken: string;
    device: {
      id: string;
      name: string;
      branchId: string;
      pairedAt: string;
    }
  }
  ```
- **Error Codes**: `400_INVALID_CODE`, `401_CODE_EXPIRED`
- **Description**: Exits with a long-lived `deviceToken` upon successful pairing.

### POST /api/pos/v1/login

Authenticates a previously paired device (legacy fallback or credential-based pairing).

- **Auth**: None
- **Request Body**:
  ```typescript
  {
    username: string;
    passwordHash: string;
    hardwareId: string;
  }
  ```
- **Response**: Same as `/api/pos/v1/pair`
- **Error Codes**: `401_UNAUTHORIZED`, `403_DEVICE_SUSPENDED`

### POST /api/pos/v1/cashier/login

Signs in a cashier to an active device using a PIN.

- **Auth**: Device Token
- **Request Body**:
  ```typescript
  {
    pin: string;
  }
  ```
- **Response**:
  ```typescript
  {
    token: string; // cashierToken
    cashier: {
      id: string;
      name: string;
      role: "cashier" | "manager";
    }
  }
  ```
- **Error Codes**: `401_INVALID_PIN`

### POST /api/pos/v1/authorize

Requests a manager override for restricted actions (e.g., large refunds, price overrides).

- **Auth**: Device + Cashier Token
- **Request Body**:
  ```typescript
  {
    action: "refund" | "void" | "discount";
    amount?: number;
    managerPin: string;
  }
  ```
- **Response**:
  ```typescript
  {
    grant: string; // one-time use token
    authorizedBy: string; // manager ID
  }
  ```
- **Error Codes**: `403_INSUFFICIENT_PERMISSIONS`

### GET /api/pos/v1/ping

Device heartbeat to check connectivity and sync time.

- **Auth**: Device Token
- **Response**:
  ```typescript
  {
    ok: boolean;
    serverTime: string; // ISO 8601
  }
  ```

---

## Sync & Catalog

### GET /api/pos/v1/catalog

Fetches the tenant's product catalog, pricing, and shift configuration for offline caching.

- **Auth**: Device Token
- **Response**:
  ```typescript
  {
    catalogVersion: string;
    menu: ProductCategory[];
    pricing: PriceBook;
    shiftPolicy: {
      requireOpeningCount: boolean;
      requireClosingCount: boolean;
    };
  }
  ```

### GET /api/pos/v1/realtime

Gets Server-Sent Events (SSE) configuration for real-time order updates.

- **Auth**: Device Token
- **Response**:
  ```typescript
  {
    enabled: boolean;
    config: {
      endpoint: string;
      topics: string[];
    }
  }
  ```

### GET /api/pos/v1/sync/auth

Syncs the cashier roster for offline PIN validation.

- **Auth**: Device Token
- **Response**:
  ```typescript
  {
    roster: Array<{ id: string, name: string, pinHash: string, role: string }>;
  }
  ```

### POST /api/pos/v1/sync/events

Ingests batches of offline events (sales, shifts) when connectivity is restored.

- **Auth**: Device Token
- **Request Body**:
  ```typescript
  {
    events: Array<{ type: string, payload: any, timestamp: string, id: string }>;
  }
  ```
- **Response**: `{ processedCount: number, errors: Array<{ id: string, reason: string }> }`
- **Error Codes**: `413_PAYLOAD_TOO_LARGE` (max 50 events per batch)

---

## Shift Management

### POST /api/pos/v1/shifts/open

Opens a new cash drawer shift.

- **Auth**: Device + Cashier Token
- **Request Body**: `{ openingFloat: number }`
- **Response**: `{ shift: Shift }`

### GET /api/pos/v1/shifts/current

Gets the currently active shift and its live report.

- **Auth**: Device Token
- **Response**: `{ shift: Shift, report: ShiftReport }`

### POST /api/pos/v1/shifts/current

Records a mid-shift drawer count (skims/drops).

- **Auth**: Device + Cashier Token
- **Request Body**: `{ countedAmount: number, notes?: string }`
- **Response**: `{ count: ShiftCount, report: ShiftReport }`

### POST /api/pos/v1/shifts/movements

Records a cash movement (pay in / pay out).

- **Auth**: Device + Cashier Token
- **Request Body**: `{ type: "pay_in" | "pay_out", amount: number, reason: string }`
- **Response**: `{ movement: CashMovement }`

### POST /api/pos/v1/shifts/close

Closes the shift with a final count.

- **Auth**: Device + Cashier Token
- **Request Body**: `{ closingCount: number }`
- **Response**: `{ report: ShiftReport }`

---

## Sales & Orders

### GET /api/pos/v1/sales

List historical sales for the branch.

- **Auth**: Device Token
- **Query Params**: `limit`, `offset`, `startDate`, `endDate`, `status`
- **Response**: `{ items: Receipt[], total: number }`

### POST /api/pos/v1/sales

Records a new completed sale.

- **Auth**: Device + Cashier Token
- **Request Body**:
  ```typescript
  {
    items: OrderLineItem[];
    subtotal: number;
    tax: number;
    total: number;
    tenders: Tender[];
  }
  ```
- **Response**: `{ receipt: Receipt }`

### GET /api/pos/v1/sales/[id]

Retrieves details for a specific sale.

- **Auth**: Device Token
- **Response**: `{ receipt: Receipt }`

### POST /api/pos/v1/sales/[id]/payments

Adds an additional tender to an existing open/partial order.

- **Auth**: Device + Cashier Token
- **Request Body**: `{ tender: Tender }`
- **Response**: `{ receipt: Receipt }`

### POST /api/pos/v1/sales/[id]/refund

Issues a refund for a sale.

- **Auth**: Device + Cashier Token (Manager override may be required)
- **Request Body**: `{ itemsToRefund: string[], amount: number, reason: string, grantToken?: string }`
- **Response**: `{ refundResult: RefundResult }`

### POST /api/pos/v1/sales/[id]/reprint

Logs a receipt reprint event and returns the receipt data.

- **Auth**: Device + Cashier Token
- **Response**: `{ receipt: Receipt }`

### GET /api/pos/v1/orders/list

List active branch orders (e.g., Kitchen queue).

- **Auth**: Device Token
- **Response**: `{ orders: Order[] }`

### POST /api/pos/v1/orders/status

Transitions an order's status (e.g., Preparing -> Ready).

- **Auth**: Device + Cashier Token
- **Request Body**: `{ orderId: string, status: "preparing" | "ready" | "served" }`
- **Response**: `{ success: boolean }`

---

## Held Tickets

### GET /api/pos/v1/held-tickets

Lists currently held (parked) tickets for the device.

- **Auth**: Device Token
- **Response**: `{ tickets: HeldTicket[] }`

### POST /api/pos/v1/held-tickets

Holds (parks) an active cart/ticket to process later.

- **Auth**: Device + Cashier Token
- **Request Body**: `{ name: string, items: OrderLineItem[] }`
- **Response**: `{ ticketId: string }`

### DELETE /api/pos/v1/held-tickets/[id]

Discards a held ticket.

- **Auth**: Device + Cashier Token
- **Response**: `{ success: boolean }`

---

## Reports

### GET /api/pos/v1/reports/x

Generates an X Report (current shift snapshot).

- **Auth**: Device + Cashier Token
- **Response**: `{ report: XReport }`

### GET /api/pos/v1/reports/z

Generates a Z Report (closed shift summary).

- **Auth**: Device + Cashier Token (Manager)
- **Query Params**: `shiftId`
- **Response**: `{ report: ZReport }`
