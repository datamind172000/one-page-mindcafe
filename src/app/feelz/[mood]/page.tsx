import { notFound, permanentRedirect } from "next/navigation";
import { MOOD_GRID } from "@/lib/moodStyles";

export function generateStaticParams() {
  return MOOD_GRID.map((m) => ({ mood: m.key }));
}

// Preserve inbound links while the former MindCafe shop is retired.
export default async function FeelzProductPage({ params }: { params: Promise<{ mood: string }> }) {
  const { mood } = await params;
  if (!MOOD_GRID.some((m) => m.key === mood)) notFound();
  permanentRedirect(`https://feelz.mindcafe.app/feelz/${mood}`);
}
