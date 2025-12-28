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
    // Use a stable ID per connection if none provided by client
    let sessionId = req.headers.get("mcp-session-id");
    if (!sessionId) {
      try {
        sessionId = crypto.randomUUID();
      } catch {
        sessionId = `${connection_id}-session`;
      }
    }

    // 3) Call MCP server with INITIALIZE (required first step in MCP lifecycle)
    const initBody = {
      jsonrpc: "2.0",
      id: "initialize-1",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26", // or "2024-11-05" if your server only supports that
        capabilities: {
          // minimal client capabilities; adjust if you support more
          roots: {},
          sampling: {},
        },
        clientInfo: {
          name: "va-mcp-proxy",
          version: "0.1.0",
        },
      },
    };

    const response = await fetch(conn.server_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId,
        ...(conn.api_key ? { Authorization: `Bearer ${conn.api_key}` } : {}),
      },
      body: JSON.stringify(initBody),
    });

    const json = await response.json().catch(() => null);

    // If HTTP error, surface it
    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          error: `HTTP ${response.status}`,
          response: json,
        },
        { status: 200, headers: corsHeaders }
      );
    }

    // If MCP JSON-RPC error, surface that too
    if (json?.error) {
      return NextResponse.json(
        {
          success: false,
          error: json.error.message || "MCP initialization error",
          code: json.error.code,
          response: json,
        },
        { status: 200, headers: corsHeaders }
      );
    }

    const result = json?.result;

    // 4) Optionally mark connection as active if initialization succeeded
    await supabase
      .from("va_mcp_connections")
      .update({
        status: "active",
        last_health_check: new Date().toISOString(),
      })
      .eq("id", connection_id);

    // 5) Return success + upstream response
    return NextResponse.json(
      {
        success: true,
        response: result ?? json,
        mcp_session_id: sessionId,
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