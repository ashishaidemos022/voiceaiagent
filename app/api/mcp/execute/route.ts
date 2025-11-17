"use server";

import { supabaseAdmin } from "@/lib/db";
import { MCPClient } from "@/lib/mcp-client";
import { corsHeaders, handleOptions } from "@/lib/cors";

export async function OPTIONS() {
  return handleOptions();
}

export async function POST(req: Request) {
  try {
    const { connection_id, tool_name, parameters } = await req.json();

    if (!connection_id || !tool_name) {
      return new Response(JSON.stringify({
        success: false,
        error: "Missing connection_id or tool_name"
      }), {
        status: 400,
        headers: corsHeaders
      });
    }

    const { data: conn, error } = await supabaseAdmin
      .from("mcp_connections")
      .select("*")
      .eq("id", connection_id)
      .single();

    if (error || !conn) throw new Error("Connection not found");

    const client = new MCPClient(conn.server_url, conn.api_key);
    await client.waitForReady();

    const exec = await client.executeTool(tool_name, parameters ?? {});

    return new Response(JSON.stringify({
      success: true,
      result: exec
    }), {
      headers: corsHeaders
    });

  } catch (err: any) {
    return new Response(JSON.stringify({
      success: false,
      error: err.message
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
}
