import { getAgentBrief } from "@/src/agent-brief";

export const dynamic = "force-static";
export function GET() {
  return new Response(getAgentBrief(), { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}
