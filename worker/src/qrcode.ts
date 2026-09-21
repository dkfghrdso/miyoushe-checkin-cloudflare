import qrcode from "qrcode-generator";

/** Render an otpauth URI as an inline SVG QR code. */
export function makeQrSvg(data: string): string | null {
  try {
    const qr = qrcode(0, "M");
    qr.addData(data);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  } catch (error) {
    console.error("failed to render QR", error);
    return null;
  }
}
