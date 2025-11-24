import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "@/lib/cors";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// -------------------------
// 🔧 Universal Schema Normalizer
// -------------------------
function normalizeSchema(schema: any): any {
  if (!schema) return {};

  // Already JSON Schema
  if (schema.type === "object" && schema.properties) {
    return schema;
  }

  // Array-style parameter list → convert to JSON Schema
  if (Array.isArray(schema)) {
    const properties: Record<string, any> = {};
    const required: string[] = [];

    for (const p of schema) {
      if (!p?.name) continue;

      properties[p.name] = {
        type: p.type || "string",
        description: p.description || "",
      };

      if (p.required) {
        required.push(p.name);
      }
    }

    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  // Possibly Rube-style: {schema: {...}}
  if (schema?.properties || schema?.type) {
    return schema;
  }

  return schema;
}

// -------------------------
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function POST(req: Request) {
  try {
    const { connection_id, user_id } = await req.json();

    // -------------------------
    // 🔐 Validate Inputs
    // -------------------------
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

    // -------------------------
    // 🔐 Validate Connection Ownership
    // -------------------------
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

    // -------------------------
    // 🔗 CALL MCP SERVER
    // -------------------------
    const response = await fetch(conn.server_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(conn.api_key ? { Authorization: `Bearer ${conn.api_key}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "tools-list",
        method: "tools/list",
      }),
    });

    const contentType = response.headers.get("content-type") || "";
    let json: any = null;

    // -------------------------
    // 🟢 CASE 1 — SSE STREAM
    // -------------------------
    if (contentType.includes("text/event-stream")) {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      let buffer = "";
      let finalJSON = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;

          const raw = line.replace("data:", "").trim();
          try {
            const parsed = JSON.parse(raw);
            finalJSON = parsed; // last event usually contains the full MCP response
          } catch {
            // ignore incomplete chunks
          }
        }
      }

      if (!finalJSON) {
        return NextResponse.json(
          { success: false, error: "Failed to parse SSE response" },
          { status: 500, headers: corsHeaders }
        );
      }

      json = finalJSON;
    }

    // -------------------------
    // 🔵 CASE 2 — Standard JSON
    // -------------------------
    else if (contentType.includes("application/json")) {
      json = await response.json().catch(() => null);
    }

    // -------------------------
    // 🔴 CASE 3 — Unknown Format
    // -------------------------
    else {
      return NextResponse.json(
        {
          success: false,
          error: "Unknown response format from MCP server",
          raw: await response.text(),
        },
        { status: 500, headers: corsHeaders }
      );
    }

    // -------------------------
    // ❌ MCP Returned Error
    // -------------------------
    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          error: `HTTP ${response.status}`,
          response: json,
        },
        { headers: corsHeaders }
      );
    }

    // -------------------------
    // 🧠 INTELLIGENT TOOL EXTRACTION
    // Supports:
    //   Rube: json.result.tools
    //   Composio: json.tools
    //   Generic MCP: json.result
    // -------------------------
    const tools =
      json?.result?.tools ??
      json?.result ??
      json?.tools ??
      [];

    if (!Array.isArray(tools)) {
      return NextResponse.json(
        { success: false, error: "Invalid tool response format", raw: json },
        { status: 500, headers: corsHeaders }
      );
    }

    // -------------------------
    // 📝 Normalize & Prepare Upsert Payload
    // -------------------------
    const upsertPayload = tools.map((tool: any) => {
      const schema =
        tool.inputSchema ??
        tool.input_schema ??
        tool.schema ??
        tool.parameters ??
        {};

      return {
        connection_id,
        user_id,
        tool_name: tool.name,
        description: tool.description ?? "",
        parameters_schema: normalizeSchema(schema),
        is_enabled: true,
      };
    });

    // -------------------------
    // 💾 Save Tools to Supabase
    // -------------------------
    if (upsertPayload.length > 0) {
      const { error: upErr } = await supabase
        .from("va_mcp_tools")
        .upsert(upsertPayload, { onConflict: "connection_id,tool_name" });

      if (upErr) {
        return NextResponse.json(
          { success: false, error: upErr.message },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    // -------------------------
    // 🎉 SUCCESS
    // -------------------------
    return NextResponse.json(
      { success: true, tools },
      { headers: corsHeaders }
    );
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: e.message || "Unexpected server error" },
      { status: 500, headers: corsHeaders }
    );
  }
}