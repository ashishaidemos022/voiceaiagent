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

    // Validate owner
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

    // -----------------------------
    // 🔗 CALL MCP SERVER
    // -----------------------------
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

    // Detect response content-type
    const contentType = response.headers.get("content-type") || "";

    let json: any = null;

    // ---------------------------------------
    // 🟢 CASE 1 — SSE STREAM ("text/event-stream")
    // ---------------------------------------
    if (contentType.includes("text/event-stream")) {
      const reader = response.body!.getReader();
      let sseText = "";
      const decoder = new TextDecoder();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        sseText += decoder.decode(value);
      }

      // SSE format: lines starting with "data:"
      const dataLines = sseText
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.replace("data:", "").trim());

      // Parse last event (typically final JSON)
      if (dataLines.length > 0) {
        const last = dataLines[dataLines.length - 1];
        try {
          json = JSON.parse(last);
        } catch {
          json = null;
        }
      }

      if (!json) {
        return NextResponse.json(
          { success: false, error: "Failed to parse SSE JSON", raw: sseText },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    // ---------------------------------------
    // 🔵 CASE 2 — Normal JSON response
    // ---------------------------------------
    else if (contentType.includes("application/json")) {
      json = await response.json().catch(() => null);
    }

    // ---------------------------------------
    // 🔴 UNKNOWN FORMAT
    // ---------------------------------------
    else {
      const raw = await response.text();
      return NextResponse.json(
        { success: false, error: "Unknown response format", raw },
        { status: 500, headers: corsHeaders }
      );
    }

    // If MCP returned non-OK HTTP
    if (!response.ok) {
      return NextResponse.json(
        { success: false, error: `HTTP ${response.status}`, response: json },
        { headers: corsHeaders }
      );
    }

    // ---------------------------------------
    // 🧠 INTELLIGENT TOOL EXTRACTION
    // Supports:
    //   result.tools  (standard MCP)
    //   result        (array)
    //   SSE-derived events
    // ---------------------------------------
    const tools =
      json?.result?.tools ??
      json?.result ??
      [];

    // Normalize every tool
    const upsertPayload = tools.map((tool: any) => ({
      connection_id,
      user_id,
      tool_name: tool.name,
      description: tool.description ?? "",
      parameters_schema:
        tool.inputSchema ?? tool.input_schema ?? {},
      is_enabled: true
    }));

    // Save to DB
    if (upsertPayload.length > 0) {
      const { error: upErr } = await supabase
        .from("va_mcp_tools")
        .upsert(upsertPayload, {
          onConflict: "connection_id,tool_name"
        });

      if (upErr) {
        return NextResponse.json(
          { success: false, error: upErr.message },
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