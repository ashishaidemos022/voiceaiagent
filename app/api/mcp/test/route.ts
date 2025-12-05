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
    const { connection_id } = await req.json();

    if (!connection_id) {
      return NextResponse.json(
        { success: false, error: "connection_id is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    // 1) Load MCP connection config from Supabase
    const { data: conn, error: connError } = await supabase
      .from("va_mcp_connections")
      .select("*")
      .eq("id", connection_id)
      .single();

    if (connError) {
      return NextResponse.json(
        { success: false, error: connError.message },
        { status: 500, headers: corsHeaders }
      );
    }

    if (!conn) {
      return NextResponse.json(
        { success: false, error: "Connection not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    // 2) Derive / generate MCP session id
    // Headers are case-insensitive; "mcp-session-id" works here
    let sessionId = req.headers.get("mcp-session-id");

    if (!sessionId) {
      // Generate a stable default based on connection_id for now,
      // so repeated tests for same connection share a session.
      // If you prefer fully random each time, use crypto.randomUUID().
      try {
        sessionId = crypto.randomUUID();
      } catch {
        // Fallback if crypto.randomUUID isn't available for some reason
        sessionId = `${connection_id}-session`;
      }
    }

    // 3) Call the Supabase MCP server with required header
    const response = await fetch(conn.server_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId,
        ...(conn.api_key ? { Authorization: `Bearer ${conn.api_key}` } : {})
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "ping",
        method: "ping"
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
        { status: 200, headers: corsHeaders } // keep outer API 200 for your client contract
      );
    }

    // 4) Update connection health in Supabase
    await supabase
      .from("va_mcp_connections")
      .update({
        status: "active",
        last_health_check: new Date().toISOString()
      })
      .eq("id", connection_id);

    // 5) Return success + upstream response
    return NextResponse.json(
      {
        success: true,
        response: json,
        mcp_session_id: sessionId
      },
      { headers: corsHeaders }
    );
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: e.message || "Unexpected error" },
      { status: 500, headers: corsHeaders }
    );
  }
}