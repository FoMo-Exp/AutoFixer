import { useMemo } from "react";
import type { ReactElement } from "react";
import { encode } from "uqr";

interface InviteQrCodeProps {
  /** The trusted-service invite URL; the token rides in its fragment. */
  value: string;
  label: string;
}

/**
 * Renders the invite URL as QR modules. The URL is encoded into geometry only:
 * no text node carries the token, so the QR never widens the token's exposure
 * beyond the one-time create response.
 */
export function InviteQrCode({ value, label }: InviteQrCodeProps): ReactElement {
  const { size, path } = useMemo(() => {
    const { size, data } = encode(value, { ecc: "M", border: 1 });
    const rows: string[] = [];
    data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) rows.push(`M${x} ${y}h1v1h-1z`);
      }),
    );
    return { size, path: rows.join("") };
  }, [value]);

  return (
    <svg
      className="invite-qr"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} className="invite-qr-ground" />
      <path d={path} className="invite-qr-ink" />
    </svg>
  );
}
