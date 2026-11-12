import { describe, it, expect } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import DashboardError from "./error";
import { UnauthorizedError } from "@/server/rbac/authorize";

import { PermissionDenied } from "@/components/dashboard/PermissionDenied";

describe("Dashboard RBAC refusal handling (Issue #172)", () => {
  it("error.tsx renders permission refusal state when error is UnauthorizedError", () => {
    const error = new UnauthorizedError("menu:manage");
    const html = renderToString(
      React.createElement(DashboardError, {
        error,
        reset: () => {},
      })
    );

    expect(html).toContain("Permission required");
    expect(html).toContain("Missing permission: menu:manage");
    expect(html).toContain("Back to Dashboard");
    expect(html).not.toContain("Try again");
    expect(html).not.toContain("Something went wrong");
  });

  it("PermissionDenied component renders named permission requirement and onward link", () => {
    const html = renderToString(
      React.createElement(PermissionDenied, {
        permission: "reports:view",
      })
    );

    expect(html).toContain("Permission required");
    expect(html).toContain("reports:view");
    expect(html).toContain("Back to Dashboard");
  });

  it("error.tsx renders standard retry state for generic unexpected crashes", () => {
    const error = new Error("Database connection lost");
    const html = renderToString(
      React.createElement(DashboardError, {
        error,
        reset: () => {},
      })
    );

    expect(html).toContain("Something went wrong");
    expect(html).toContain("Retry");
    expect(html).not.toContain("Permission required");
  });
});
