import { StorefrontVisit } from "@/components/StorefrontVisit";

export default function FeelzLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <StorefrontVisit />
      {children}
    </>
  );
}
