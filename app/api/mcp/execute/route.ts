// app/api/mcp/execute/route.ts
import { supabaseAdmin } from "@/lib/db";
import { MCPClient } from "@/lib/mcp-client";

export async function POST(req: Request) {
  const { connection_id, tool_name, parameters } = await req.json();

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

    const result = await client.executeTool(tool_name, parameters);

    return Response.json({ success: true, result });
  } catch (err: any) {
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
}
