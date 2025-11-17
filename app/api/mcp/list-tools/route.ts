// app/api/mcp/list-tools/route.ts
import { supabaseAdmin } from "@/lib/db";
import { MCPClient } from "@/lib/mcp-client";

export async function POST(req: Request) {
  const { connection_id } = await req.json();

  const { data, error } = await supabaseAdmin
    .from("mcp_connections")
    .select("*")
    .eq("id", connection_id)
    .single();

  if (error || !data) {
    return Response.json({ success: false, error: "Connection not found" }, { status: 404 });
  }

  try {
    const client = new MCPClient(data.server_url, data.api_key);
    await client.waitForReady();

    const res = await client.listTools();
    const tools = res.result?.tools ?? res.tools ?? [];

    return Response.json({ success: true, tools });
  } catch (err: any) {
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
