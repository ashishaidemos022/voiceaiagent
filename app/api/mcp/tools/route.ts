import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "@/lib/cors";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/* ----------------------------------------------------
   Schema Normalizer — Converts ANY schema into JSONSchema
---------------------------------------------------- */
function normalizeSchema(schema: any): any {
  if (!schema) return {};

  // Already a JSON schema
  if (schema.type === "object" && schema.properties) return schema;

  // Rube sometimes returns array-based schema
  if (Array.isArray(schema)) {
    const properties: Record<string, any> = {};
    const required: string[] = [];

    for (const p of schema) {
      if (!p?.name) continue;
      properties[p.name] = {
        type: p.type || "string",
        description: p.description || "",
      };
      if (p.required) required.push(p.name);
    }

    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  // Fallback passthrough
  return schema;
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function POST(req: Request) {
  try {
    const { connection_id, user_id } = await req.json();

    /* ----------------------------------------------------
       Validate Inputs
    ---------------------------------------------------- */
    if (!connection_id || !user_id) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing required fields: connection_id, user_id",
        },
        { status: 400, headers: corsHeaders }
      );
    }

    /* ----------------------------------------------------
       Validate Connection Ownership
    ---------------------------------------------------- */
    const { data: conn } = await supabase
      .from("va_mcp_connections")
      .select("*")
      .eq("id", connection_id)
      .eq("user_id", user_id)
      .single();

    if (!conn) {
      return NextResponse.json(
        {
          success: false,
          error: "Connection not found or unauthorized",
        },
        { status: 404, headers: corsHeaders }
      );
    }

    /* ----------------------------------------------------
       Call MCP Server → tools/list
    ---------------------------------------------------- */
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

    /* ----------------------------------------------------
       Handle SSE Stream
    ---------------------------------------------------- */
    if (contentType.includes("text/event-stream")) {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      let buffer = "";
      let lastJSON: any = null;

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
            } catch {
              /* ignore */
            }
          }
        }
      }

      json = lastJSON ?? {};
    }

    /* ----------------------------------------------------
       Handle JSON
    ---------------------------------------------------- */
    else if (contentType.includes("application/json")) {
      json = await response.json().catch(() => null);
    }

    /* ----------------------------------------------------
       Unknown Format
    ---------------------------------------------------- */
    else {
      return NextResponse.json(
        {
          success: false,
          error: "Unknown response format from MCP server",
        },
        { status: 500, headers: corsHeaders }
      );
    }

    /* ----------------------------------------------------
       Extract Rube tool_schemas when present
       (Critical for Gmail, Slack, Google Drive, etc.)
    ---------------------------------------------------- */
    const rubeSchemas =
      json?.data?.data?.tool_schemas ||
      json?.result?.data?.tool_schemas ||
      null;

    let tools: any[] = [];

    if (rubeSchemas && typeof rubeSchemas === "object") {
      tools = Object.values(rubeSchemas).map((tool: any) => ({
        name: tool.tool_slug,
        description: tool.description || "",
        parameters_schema: tool.input_schema || tool.inputSchema || {},
      }));
    }

    /* ----------------------------------------------------
       Fallback for normal MCP servers (OpenAI, Anthropic)
    ---------------------------------------------------- */
    if (tools.length === 0) {
      tools =
        json?.result?.tools ??
        json?.result ??
        json?.tools ??
        [];
    }

    if (!Array.isArray(tools)) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid tool response format",
          raw: json,
        },
        { status: 500, headers: corsHeaders }
      );
    }

    /* ----------------------------------------------------
       Normalize Schema + Upsert to Supabase
    ---------------------------------------------------- */
    const upsertPayload = tools.map((tool: any) => ({
      connection_id,
      user_id,
      tool_name: tool.name,
      description: tool.description ?? "",
      parameters_schema: normalizeSchema(tool.parameters_schema),
      is_enabled: true,
    }));

    if (upsertPayload.length > 0) {
      const { error: upErr } = await supabase
        .from("va_mcp_tools")
        .upsert(upsertPayload, {
          onConflict: "connection_id,tool_name",
        });

      if (upErr) {
        return NextResponse.json(
          { success: false, error: upErr.message },
          { status: 500, headers: corsHeaders }
        );
      }
    }

    /* ----------------------------------------------------
       SUCCESS
    ---------------------------------------------------- */
    return NextResponse.json(
      {
        success: true,
        tools,
      },
      { headers: corsHeaders }
    );
  } catch (e: any) {
    return NextResponse.json(
      {
        success: false,
        error: e.message || "Unexpected server error",
      },
      { status: 500, headers: corsHeaders }
    );
  }
}