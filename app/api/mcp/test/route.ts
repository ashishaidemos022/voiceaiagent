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

    const { data: conn, error } = await supabase
      .from("mcp_connections")
      .select("*")
      .eq("id", connection_id)
      .single();

    if (!conn) {
      return NextResponse.json(
        { success: false, error: "Connection not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    const response = await fetch(conn.server_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
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
        { success: false, error: `HTTP ${response.status}`, response: json },
        { headers: corsHeaders }
      );
    }

    await supabase
      .from("mcp_connections")
      .update({
        status: "active",
        last_health_check: new Date().toISOString()
      })
      .eq("id", connection_id);

    return NextResponse.json(
      { success: true, response: json },
      { headers: corsHeaders }
    );
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: e.message },
      { status: 500, headers: corsHeaders }
    );
  }
}