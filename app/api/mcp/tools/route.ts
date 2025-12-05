import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "@/lib/cors";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// -----------------------------------------------
// Robust Schema Normalizer
// -----------------------------------------------
function normalizeSchema(input: any): any {
  if (!input) return { type: "object", properties: {} };

  // Already JSON Schema-ish
  if (input.type === "object" && input.properties) {
    return input;
  }

  // Rube-style array of fields
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

  // Generic object – trust it
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
    const { data: conn, error: connErr } = await supabase
      .from("va_mcp_connections")
      .select("*")
      .eq("id", connection_id)
      .eq("user_id", user_id)
      .single();

    if (connErr) {
      return NextResponse.json(
        { success: false, error: connErr.message },
        { status: 500, headers: corsHeaders }
      );
    }

    if (!conn) {
      return NextResponse.json(
        { success: false, error: "Connection not found or unauthorized" },
        { status: 404, headers: corsHeaders }
      );
    }

    // -------------------------------------------------
    // Ensure Mcp-Session-Id (create if missing)
    // -------------------------------------------------
    const incomingHeaders = req.headers;
    const incomingSessionId =
      incomingHeaders.get("Mcp-Session-Id") ||
      incomingHeaders.get("mcp-session-id") ||
      undefined;

    const sessionId = incomingSessionId || crypto.randomUUID();

    // -------------------------------------------------
    // Call MCP server (tools/list)
    // -------------------------------------------------
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
        id: "tools-list",
        method: "tools/list"
      })
    });

    const contentType = response.headers.get("content-type") || "";
    let json: any = null;

    // -------------------------------------------------
    // Parse SSE stream (if MCP streams tools)
    // -------------------------------------------------
    if (contentType.includes("text/event-stream")) {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let lastJSON: any = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data:")) {
            const raw = line.replace("data:", "").trim();
            if (!raw) continue;
            try {
              lastJSON = JSON.parse(raw);
            } catch {
              // ignore malformed chunks
            }
          }
        }
      }

      json = lastJSON ?? {};
    }

    // -------------------------------------------------
    // Or parse regular JSON
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

    // Optional: log raw for debugging in Vercel
    console.log("MCP tools raw response:", JSON.stringify(json, null, 2));

    // -------------------------------------------------
    // Extract tools for different MCP server flavours
    // -------------------------------------------------
    let tools: any[] = [];

    // 1) Rube-style → tool_schemas
    const rubeSchemas =
      json?.data?.data?.tool_schemas ??
      json?.result?.tool_schemas ??
      null;

    if (rubeSchemas && typeof rubeSchemas === "object") {
      tools = Object.values(rubeSchemas).map((tool: any) => ({
        name: tool.tool_slug || tool.name,
        description: tool.description || "",
        parameters_schema: normalizeSchema(
          tool.parameters_schema ||
          tool.input_schema ||
          tool.inputSchema ||
          tool.schema ||
          {}
        )
      }));
    }

    // 2) Generic MCP (Supabase etc.) including object=list, data=[...]
    if (tools.length === 0) {
      const result = json.result ?? json;
      let rawTools: any = null;

      // Plain array
      if (Array.isArray(result)) {
        rawTools = result;
      }
      // result.tools
      else if (Array.isArray(result?.tools)) {
        rawTools = result.tools;
      }
      // result.data.tools
      else if (Array.isArray(result?.data?.tools)) {
        rawTools = result.data.tools;
      }
      // top-level tools
      else if (Array.isArray(json.tools)) {
        rawTools = json.tools;
      }
      // Supabase-style: { object: "list", data: [ { object: "tool", ... } ] }
      else if (result?.object === "list" && Array.isArray(result?.data)) {
        rawTools = result.data.map((item: any) => {
          // sometimes tool lives under item.tool, otherwise item itself
          return item.tool || item;
        });
      }

      if (Array.isArray(rawTools)) {
        tools = rawTools.map((tool: any) => ({
          name: tool.name,
          description: tool.description || "",
          parameters_schema: normalizeSchema(
            tool.parameters_schema ||
            tool.parameters ||
            tool.input_schema ||
            tool.inputSchema ||
            tool.schema ||
            {}
          )
        }));
      }
    }

    if (!Array.isArray(tools) || tools.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: "No tools found in MCP response",
          raw: json
        },
        { status: 500, headers: corsHeaders }
      );
    }

    // -------------------------------------------------
    // Build UPSERT payload (Overwrite mode)
    // -------------------------------------------------
    const now = new Date().toISOString();

    const payload = tools.map((tool: any) => ({
      connection_id,
      user_id,
      tool_name: tool.name,
      description: tool.description ?? "",
      parameters_schema: normalizeSchema(tool.parameters_schema),
      is_enabled: true,
      updated_at: now
    }));

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
      {
        success: true,
        tools,
        mcp_session_id: sessionId
      },
      { headers: corsHeaders }
    );
  } catch (e: any) {
    console.error("MCP tools route error:", e);
    return NextResponse.json(
      { success: false, error: e.message },
      { status: 500, headers: corsHeaders }
    );
  }
}