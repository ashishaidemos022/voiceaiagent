import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "@/lib/cors";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function POST(req: Request) {
  try {
    const { connection_id, user_id } = await req.json();

    if (!user_id) {
      return NextResponse.json(
        { success: false, error: "Missing user_id" },
        { status: 400, headers: corsHeaders }
      );
    }

    if (!connection_id) {
      return NextResponse.json(
        { success: false, error: "Missing connection_id" },
        { status: 400, headers: corsHeaders }
      );
    }

    // ---------------------------
    // 🔐 VALIDATE CONNECTION BELONGS TO USER
    // ---------------------------
    const { data: conn, error: connErr } = await supabase
      .from("va_mcp_connections")
      .select("*")
      .eq("id", connection_id)
      .eq("user_id", user_id)
      .single();

    if (connErr || !conn) {
      return NextResponse.json(
        { success: false, error: "Connection not found or unauthorized" },
        { status: 404, headers: corsHeaders }
      );
    }

    // ---------------------------
    // 🔗 CALL THE MCP SERVER
    // ---------------------------
    const response = await fetch(conn.server_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        ...(conn.api_key ? { Authorization: `Bearer ${conn.api_key}` } : {})
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "tools-list",
        method: "tools/list"
      })
    });

    const json = await response.json().catch(() => null);

    if (!response.ok) {
      return NextResponse.json(
        { 
          success: false, 
          error: `HTTP ${response.status}`, 
          response: json 
        },
        { headers: corsHeaders }
      );
    }

    const tools = json?.result?.tools ?? [];

    // ---------------------------
    // 📝 UPSERT TOOLS INTO Supabase
    // ---------------------------
    const upsertPayload = tools.map((tool: any) => ({
      connection_id,
      user_id, // REQUIRED
      tool_name: tool.name,
      description: tool.description ?? "",
      parameters_schema: tool.inputSchema ?? {},
      is_enabled: true
    }));

    if (upsertPayload.length > 0) {
      const { error: upErr } = await supabase
        .from("va_mcp_tools")
        .upsert(upsertPayload, {
          onConflict: "connection_id,tool_name"
        });

      if (upErr) {
        return NextResponse.json(
          { 
            success: false, 
            error: "Failed saving tools",
            details: upErr.message 
          },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    return NextResponse.json(
      { success: true, tools },
      { headers: corsHeaders }
    );

  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: e.message },
      { status: 500, headers: corsHeaders }
    );
  }
}