import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#17100B",
        }}
      >
        <svg width="120" height="120" viewBox="0 0 100 100">
          <path d="M26 32 L74 32 L50 78 Z" fill="none" stroke="#F0522B" strokeWidth={6} strokeLinejoin="round" />
          <circle cx="26" cy="32" r="9" fill="#F0522B" />
          <circle cx="74" cy="32" r="9" fill="#F0522B" />
          <circle cx="50" cy="78" r="9" fill="#F0522B" />
        </svg>
      </div>
    ),
    size,
  );
}
