import { permanentRedirect } from "next/navigation";

// Legacy MindCafe storefront URL: Feelz now lives on its own domain.
export default function FeelzPage() {
  permanentRedirect("https://feelz.mindcafe.app");
}
