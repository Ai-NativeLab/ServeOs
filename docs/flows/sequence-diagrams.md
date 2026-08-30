# ServeOS Sequence & Flow Diagrams

This document provides comprehensive, end-to-end Mermaid sequence diagrams illustrating data and control flow across surfaces, APIs, domain services, database transactions, and third-party systems in ServeOS.

## 1. Storefront Online Order Placement

**Description**: End-to-end flow of a customer placing an online order through the storefront.
**Actors**: Customer, Storefront App, ServeOS API, Domain Services, Database.
**Error Paths**: Out of stock, payment failure, invalid tax configuration.

```mermaid
sequenceDiagram
    actor Customer
    participant Storefront
    participant API as API (/api/orders)
    participant OrderSvc as ordering.service
    participant TaxCalc as order-totals.ts
    participant DB as Database
    participant PubSub as Real-time Broadcast

    Customer->>Storefront: Add items to cart & Checkout
    Storefront->>API: POST /api/orders (Cart data)
    API->>OrderSvc: placeOrder(cart)
    
    OrderSvc->>DB: BEGIN TRANSACTION
    OrderSvc->>DB: pg_advisory_xact_lock(tenant_id)
    
    OrderSvc->>DB: Verify stock / Recipe BOM
    alt Out of Stock
        DB-->>OrderSvc: Stock insufficient
        OrderSvc-->>API: 400 Bad Request (Out of stock)
        API-->>Storefront: Error
        Storefront-->>Customer: Display out of stock message
    else Stock Available
        OrderSvc->>TaxCalc: compute(items)
        TaxCalc-->>OrderSvc: tax_totals, grand_total
        
        OrderSvc->>DB: INSERT orders
        OrderSvc->>DB: INSERT order_items
        OrderSvc->>DB: INSERT order_status_events
        OrderSvc->>DB: INSERT audit_events (action: order_placed)
        
        OrderSvc->>DB: COMMIT
        
        OrderSvc->>PubSub: emit('order.created', order_id)
        OrderSvc-->>API: 201 Created (order_id)
        API-->>Storefront: Success
        Storefront-->>Customer: Show Order Confirmation
    end
```

## 2. POS Device Pairing & Cashier Authentication

**Description**: Flow for pairing an Electron POS device to a tenant and logging in a cashier.
**Actors**: Merchant (Dashboard), Cashier (POS), Server, Database.
**Error Paths**: Invalid/expired code, invalid credentials.

```mermaid
sequenceDiagram
    actor Merchant
    actor Cashier
    participant Dashboard
    participant POS as Electron POS
    participant Server as ServeOS API
    participant DB as Database

    %% Pairing Flow
    Merchant->>Dashboard: Generate pairing code
    Dashboard->>Server: POST /api/pos/v1/pair/code
    Server->>DB: Store 6-digit code (TTL: 10m)
    Server-->>Dashboard: Returns 123456
    Merchant-->>Cashier: Provides code 123456
    
    Cashier->>POS: Enter 123456
    POS->>Server: POST /api/pos/v1/pair
    Server->>DB: Validate & mark code used
    Server->>DB: INSERT pos_devices
    Server-->>POS: Long-lived Device Bearer Token
    
    %% Authentication Flow
    Cashier->>POS: Enter PIN/Credentials
    POS->>Server: POST /api/pos/v1/cashier/login
    Server->>DB: Fetch cashier by PIN/ID
    Server->>Server: Verify bcrypt/scrypt hash
    alt Invalid Credentials
        Server-->>POS: 401 Unauthorized
        POS-->>Cashier: Show error
    else Valid Credentials
        Server->>DB: INSERT pos_cashier_sessions
        Server-->>POS: Cashier Session Token
        POS-->>Cashier: Show Home Screen
    end
```

## 3. POS Sale Recording & Multi-Tender Payment

**Description**: Cashier rings up items, applies modifications, and tenders payment.
**Actors**: Cashier, POS, Server, Database.
**Error Paths**: Missing idempotency, invalid tender amounts.

```mermaid
sequenceDiagram
    actor Cashier
    participant POS
    participant Server as API (/api/pos/v1/sales)
    participant Svc as recordSale
    participant DB as Database

    Cashier->>POS: Scan items, apply discounts
    Cashier->>POS: Tender payment (Cash/Card)
    POS->>Server: POST /api/pos/v1/sales (RecordSaleInput, idempotency_uuid)
    
    Server->>Svc: process(input, uuid)
    
    Svc->>DB: BEGIN TRANSACTION
    Svc->>DB: Check pos_order_receipts for uuid
    alt Already processed
        DB-->>Svc: Exists
        Svc-->>Server: Return existing receipt
    else New Request
        Svc->>DB: INSERT orders
        Svc->>DB: INSERT order_items
        Svc->>DB: INSERT order_payments
        Svc->>DB: INSERT pos_adjustment_events (discounts/voids)
        
        %% Inventory deduction
        Svc->>DB: Query inventory_lots (FIFO)
        Svc->>DB: UPDATE inventory_lots (deduct qty_remaining)
        
        Svc->>DB: INSERT audit_events
        Svc->>DB: INSERT pos_order_receipts
        
        Svc->>DB: COMMIT
        
        Svc-->>Server: Receipt
    end
    
    Server-->>POS: 201 Created (Receipt)
    POS-->>Cashier: Print/Email Receipt
```

## 4. POS Shift Lifecycle & Cash Drawer Reconciliation

**Description**: Opening a shift, performing cash movements, and closing the shift with variance checking.
**Actors**: Cashier, POS, Server, Database.

```mermaid
sequenceDiagram
    actor Cashier
    participant POS
    participant Server as API (Shifts)
    participant DB as Database

    %% Open Shift
    Cashier->>POS: Enter opening float ($200)
    POS->>Server: POST /api/pos/v1/shifts/open
    Server->>DB: INSERT pos_shifts (status: open, float: 200)
    Server-->>POS: Success

    %% Mid-shift Operations
    Cashier->>POS: Perform Safe Drop ($500)
    POS->>Server: POST /api/pos/v1/cash-movements
    Server->>DB: INSERT pos_cash_movements (type: safe_drop)
    Server-->>POS: Success
    
    Cashier->>POS: Request X-Report
    POS->>Server: GET /api/pos/v1/reports/x
    Server->>DB: Aggregate current shift totals
    Server-->>POS: X-Report Data

    %% Close Shift
    Cashier->>POS: Count drawer (denominations)
    POS->>Server: POST /api/pos/v1/shifts/close (counted totals)
    
    Server->>Server: Calculate expected total (Float + Cash Sales - Drops/Payouts)
    Server->>Server: Compute variance = Counted - Expected
    
    Server->>DB: BEGIN
    Server->>DB: INSERT cash_counts
    Server->>DB: UPDATE pos_shifts (status: closed, variance)
    Server->>DB: Generate Z-Report
    Server->>DB: COMMIT
    
    Server-->>POS: Z-Report & Close Confirmation
    POS-->>Cashier: Shift Closed
```

## 5. POS Refund & Restock Processing

**Description**: Refunding items from a previous sale and optionally returning them to stock.
**Actors**: Cashier, POS, Server, Database.

```mermaid
sequenceDiagram
    actor Cashier
    participant POS
    participant Server as API (/api/pos/v1/sales/[id]/refund)
    participant Svc as issueRefund
    participant DB as Database

    Cashier->>POS: Select order & items to refund
    Cashier->>POS: Toggle "Restock" flag
    POS->>Server: POST refund request
    
    Server->>Svc: process(refund_input)
    Svc->>Svc: Verify pos:refund permission
    
    Svc->>DB: BEGIN
    Svc->>DB: INSERT refunds
    Svc->>DB: INSERT refund_lines
    Svc->>DB: INSERT refund_payments
    
    opt restock == true
        Svc->>DB: INSERT stock_ledger (type: refund_restock)
        Svc->>DB: UPDATE inventory_lots (increase qty)
    end
    
    Svc->>DB: UPDATE orders (payment_status: refunded/partially_refunded)
    Svc->>DB: COMMIT
    
    Svc-->>Server: RefundResult
    Server-->>POS: 200 OK (RefundResult)
```

## 6. Inventory Recipe/BOM Auto-Deduction (FIFO Lots)

**Description**: Automatic deduction of raw ingredients based on recipe definitions when a product is sold.
**Actors**: Domain Service (Order Confirmation), Inventory Service, Database.

```mermaid
sequenceDiagram
    participant OrderSvc as Order Domain Service
    participant InvSvc as Inventory Service
    participant DB as Database
    participant PubSub as Event Bus

    OrderSvc->>InvSvc: handleSaleDeductions(order_items)
    
    InvSvc->>DB: Fetch product_inventory_links & recipe_components
    DB-->>InvSvc: BOM definition
    
    loop For each ingredient in BOM
        InvSvc->>DB: Query inventory_lots ORDER BY expiry_at ASC, created_at ASC
        DB-->>InvSvc: Available Lots (FIFO)
        
        InvSvc->>InvSvc: Calculate deduction per lot
        
        InvSvc->>DB: UPDATE inventory_lots (decrement qty_remaining)
        InvSvc->>DB: INSERT stock_ledger (type: sale_deduction)
        
        InvSvc->>DB: Check total on-hand vs reorder_point
        alt total < reorder_point
            InvSvc->>PubSub: emit('inventory.low_stock', ingredient_id)
        end
    end
```

## 7. Purchase Order Lifecycle & Receiving

**Description**: End-to-end lifecycle of a purchase order, from draft to receiving and invoice reconciliation.
**Actors**: Manager, Supplier, ServeOS, Database, Resend (Email API).

```mermaid
sequenceDiagram
    actor Manager
    actor Supplier
    participant App as ServeOS
    participant Resend as Resend API
    participant DB as Database

    %% Draft & Send
    Manager->>App: Create Draft PO
    App->>DB: INSERT purchase_orders (status: draft)
    Manager->>App: Send to Supplier
    App->>Resend: POST /emails (PO PDF)
    App->>DB: UPDATE purchase_orders (status: sent)
    
    %% Delivery
    Supplier-->>Manager: Delivers goods
    
    %% Receiving
    Manager->>App: Post Receipt
    App->>DB: BEGIN
    App->>DB: INSERT po_receipts, po_receipt_lines
    App->>DB: INSERT inventory_lots
    App->>DB: INSERT stock_ledger (type: receive)
    App->>DB: COMMIT
    
    %% Invoice & Close
    Manager->>App: Enter Invoice Total
    App->>App: getPoVariance()
    App->>DB: UPDATE purchase_orders (status: closed)
```

## 8. Tamper-Evident Cryptographic Audit Chain

**Description**: Mechanism for recording immutable audit logs using cryptographic hashing to prevent tampering.
**Actors**: Any Domain Service, Database.

```mermaid
sequenceDiagram
    participant Svc as Domain Service
    participant DB as Database
    participant Hash as Crypto Lib

    Svc->>Svc: recordAuditEvent(ctx, action)
    
    %% Inside active transaction
    Svc->>DB: pg_advisory_xact_lock(tenant_id + 'audit')
    
    Svc->>DB: SELECT seq, head_hash FROM audit_chain_heads WHERE tenant_id = ?
    DB-->>Svc: prev_seq, prev_hash
    
    Svc->>Hash: canonicalize(prev_hash, seq+1, tenant, actor, action, metadata, fingerprint)
    Hash-->>Svc: canonical_string
    Svc->>Hash: sha256(canonical_string)
    Hash-->>Svc: entry_hash
    
    Svc->>DB: INSERT audit_events (..., hash: entry_hash)
    Svc->>DB: UPDATE audit_chain_heads (seq: seq+1, head_hash: entry_hash)
```

## 9. WhatsApp Conversational Ordering & Storefront Cart Handoff

**Description**: Customer builds a cart via WhatsApp bot and completes checkout on the web storefront.
**Actors**: Customer, Meta WhatsApp API, ServeOS Webhook, State Machine, Storefront Web.

```mermaid
sequenceDiagram
    actor Customer
    participant Meta as Meta WhatsApp
    participant API as /api/whatsapp/webhook
    participant SM as Bot State Machine
    participant DB as Database
    participant Web as Storefront Checkout

    Customer->>Meta: "I want to order food"
    Meta->>API: Webhook payload
    API->>SM: parseIntent()
    SM->>DB: Fetch Categories -> Send to Meta
    Meta-->>Customer: Show categories
    
    Customer->>Meta: Select product
    Meta->>API: Webhook (Add to cart)
    API->>DB: Update whatsapp_sessions (cart state)
    
    Customer->>Meta: "Checkout"
    Meta->>API: Webhook (Checkout)
    API->>DB: INSERT cart_handoff_tokens
    API->>Meta: Send short link (serveos.com/c/TOKEN)
    
    Customer->>Web: Open link
    Web->>API: GET cart data via TOKEN
    API-->>Web: Cart Details
    Web->>Web: Complete standard web checkout
```

## 10. Pharmacy Prescription Verification Flow

**Description**: Customer uploads a prescription during checkout, which requires pharmacist verification.
**Actors**: Customer, Storefront, ServeOS API, Supabase Storage, Pharmacist (Dashboard), DB.

```mermaid
sequenceDiagram
    actor Customer
    participant Storefront
    participant API as /api/prescriptions
    participant Storage as Supabase Storage
    participant DB as Database
    actor Pharmacist

    Customer->>Storefront: Upload Rx Image & Checkout
    Storefront->>API: POST /api/prescriptions (multipart)
    
    API->>Storage: upload(image)
    Storage-->>API: URL
    
    API->>DB: INSERT prescriptions (status: pending, url)
    API->>DB: INSERT orders (status: pending_rx)
    API-->>Storefront: Success
    
    %% Verification
    Pharmacist->>DB: View Dashboard Queue (/dashboard/prescriptions)
    DB-->>Pharmacist: Pending prescriptions
    
    Pharmacist->>Pharmacist: Review Image
    Pharmacist->>API: Approve/Reject Rx
    
    alt Approved
        API->>DB: UPDATE prescriptions (status: approved)
        API->>DB: UPDATE orders (status: confirmed)
    else Rejected
        API->>DB: UPDATE prescriptions (status: rejected)
        API->>DB: UPDATE orders (status: cancelled)
    end
```
