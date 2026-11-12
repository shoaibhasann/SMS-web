import Image from "next/image";
import logo from "@/public/brand/sms-logo.png";

/** The SMS logo tile. Decorative: every place that shows it also spells out "SMS" as text. */
export function BrandLogo({ size }: { size: number }) {
  // Served as the original PNG: the optimizer's 2x lossy variants looked soft on 3x phone screens.
  return <Image src={logo} alt="" width={size} height={size} unoptimized className="shrink-0" />;
}
