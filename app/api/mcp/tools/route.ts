import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "@/lib/cors";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// -----------------------------------------------
// Robust Schema Normalizer (Rube → JSON Schema)
// -----------------------------------------------
function normalizeSchema(input: any): any {
  if (!input) return { type: "object", properties: {} };

  // If already valid JSON schema:
  if (input.type === "object" && input.properties) {
    return input;
  }

  // If input_schema is an array of fields:
  if (Array.isArray(input)) {
    const properties: Record<string, any> = {};
    const required: string[] = [];

    for (const field of input) {
      if (!field?.name) continue;

      properties[field.name] = {
        type: field.type || "string",
        description: field.description || ""
      };

      if (field.required) required.push(field.name);
    }

    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {})
    };
  }

  // If Rube gives nested structures
  if (typeof input === "object" && Object.keys(input).length > 0) {
    return input;
  }

  return { type: "object", properties: {} };
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function POST(req: Request) {
  try {
    const { connection_id, user_id } = await req.json();

    if (!connection_id || !user_id) {
      return NextResponse.json(
        { success: false, error: "Missing connection_id or user_id" },
        { status: 400, headers: corsHeaders }
      );
    }

    // -------------------------------------------------
    // Validate connection belongs to user
    // -------------------------------------------------
    const { data: conn } = await supabase
      .from("va_mcp_connections")
      .select("*")
      .eq("id", connection_id)
      .eq("user_id", user_id)
      .single();

    if (!conn) {
      return NextResponse.json(
        { success: false, error: "Connection not found or unauthorized" },
        { status: 404, headers: corsHeaders }
      );
    }

    // -------------------------------------------------
    // Call MCP server (tools/list)
    // -------------------------------------------------
    const response = await fetch(conn.server_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(conn.api_key ? { Authorization: `Bearer ${conn.api_key}` } : {})
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "tools-list",
        method: "tools/list"
      })
    });

    const contentType = response.headers.get("content-type") || "";
    let json: any = null;

    // -------------------------------------------------
    // Parse SSE stream
    // -------------------------------------------------
    if (contentType.includes("text/event-stream")) {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let lastJSON = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value);
        const lines = buffer.split("\n");
        buffer = lines.pop()!;

        for (const line of lines) {
          if (line.startsWith("data:")) {
            const raw = line.replace("data:", "").trim();
            try {
              lastJSON = JSON.parse(raw);
            } catch {}
          }
        }
      }

      json = lastJSON ?? {};
    }

    // -------------------------------------------------
    // Parse normal JSON
    // -------------------------------------------------
    else if (contentType.includes("application/json")) {
      json = await response.json().catch(() => null);
    }

    if (!json) {
      return NextResponse.json(
        { success: false, error: "MCP server returned empty response" },
        { status: 500, headers: corsHeaders }
      );
    }

    // -------------------------------------------------
    // Extract Rube schemas
    // -------------------------------------------------
    const rubeSchemas =
      json?.data?.data?.tool_schemas ??
      json?.result?.tool_schemas ??
      null;

    let tools: any[] = [];

    if (rubeSchemas && typeof rubeSchemas === "object") {
      tools = Object.values(rubeSchemas).map((tool: any) => ({
        name: tool.tool_slug,
        description: tool.description || "",
        parameters_schema: normalizeSchema(
          tool.input_schema || tool.inputSchema || {}
        )
      }));
    }

    // Fallback: generic MCP servers
    if (tools.length === 0) {
      tools = json?.result?.tools ?? json?.result ?? [];
    }

    if (!Array.isArray(tools)) {
      return NextResponse.json(
        { success: false, error: "Invalid tools format", raw: json },
        { status: 500, headers: corsHeaders }
      );
    }

    // -------------------------------------------------
    // BUILD UPSERT PAYLOAD (Overwrite mode)
    // -------------------------------------------------
    const payload = tools.map((tool: any) => ({
      connection_id,
      user_id,
      tool_name: tool.name,
      description: tool.description ?? "",
      parameters_schema: normalizeSchema(tool.parameters_schema),
      is_enabled: true,
      updated_at: new Date().toISOString()
    }));

    // -------------------------------------------------
    // Overwrite existing → Upsert with onConflict
    // -------------------------------------------------
    const { error: upErr } = await supabase
      .from("va_mcp_tools")
      .upsert(payload, {
        onConflict: "connection_id,tool_name"
      });

    if (upErr) {
      return NextResponse.json(
        { success: false, error: upErr.message },
        { status: 500, headers: corsHeaders }
      );
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