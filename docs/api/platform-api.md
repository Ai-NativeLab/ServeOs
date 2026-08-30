# Platform API Reference

This document covers various platform-level APIs, including Dashboard metrics, Administration, auditing, and integrations in ServeOS.

## Authentication & Authorization

Authentication mechanisms vary based on the service:
- **Dashboard & Admin APIs**: Authenticated via session cookies and standard RBAC.
- **Webhooks & Integration APIs**: Authenticated via specific API keys or HMAC signatures.

---

## Dashboard Metrics

### GET /api/dashboard/metrics

Fetches high-level metrics for the tenant dashboard.

- **Auth**: Session Cookie
- **Response**:
  ```typescript
  {
    dailySales: number;
    activeOrders: number;
    lowStockAlerts: number;
  }
  ```

### GET /api/dashboard/notifications

Retrieves unread system notifications for the current user.

- **Auth**: Session Cookie
- **Response**: `{ notifications: Notification[] }`

### POST /api/dashboard/notifications/mark-read

Marks notifications as read.

- **Auth**: Session Cookie
- **Request Body**: `{ notificationIds: string[] }`
- **Response**: `{ success: true }`

---

## Audit Logs

### GET /api/audit/logs

Retrieves system audit logs for administrative review.

- **Auth**: `admin.audit`
- **Query Params**: `limit`, `offset`, `userId`, `action`
- **Response**: `{ logs: AuditLog[], total: number }`

### GET /api/audit/export

Generates an export (CSV/JSON) of audit logs.

- **Auth**: `admin.audit`
- **Query Params**: `startDate`, `endDate`, `format`
- **Response**: `{ downloadUrl: string }`

---

## Media & Files

### POST /api/media/upload

Uploads media files (e.g., product images, supplier invoices).

- **Auth**: Session Cookie
- **Request Body**: `multipart/form-data`
- **Response**: 
  ```typescript
  {
    url: string;
    mediaId: string;
  }
  ```

---

## Integrations & Delivery

### GET /api/delivery-areas

Fetches configured delivery zones and fees.

- **Auth**: Public or API Key
- **Response**: `{ areas: DeliveryArea[] }`

### POST /api/webhooks/whatsapp

Receives incoming messages and status updates from the WhatsApp Business API.

- **Auth**: HMAC Signature Validation
- **Request Body**: Webhook payload from Meta
- **Response**: `200 OK`

---

## System & Internal

### GET /api/health

System healthcheck endpoint for load balancers and monitoring.

- **Auth**: None
- **Response**: `{ status: "ok", timestamp: string, version: string }`

### POST /api/internal/notification-worker

Triggers background notification processing (typically called via cron/scheduler).

- **Auth**: Internal Secret Key
- **Response**: `{ processed: number }`

### POST /api/demo/seed

Seeds database with demo data (only available in lower environments).

- **Auth**: Superadmin
- **Response**: `{ success: true }`
