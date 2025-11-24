import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "@/lib/cors";
import { normalizeMCPArguments } from "@/lib/mcp-normalizer"; // universal normalizer

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function POST(req: Request) {
  try {
    const { connection_id, tool_name, parameters, user_id } = await req.json();

    // ------------------------------------
    // 1. Validate inputs
    // ------------------------------------
    if (!connection_id || !tool_name || !user_id) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing required fields: connection_id, tool_name, user_id"
        },
        { status: 400, headers: corsHeaders }
      );
    }

    // ------------------------------------
    // 2. Validate user connection
    // ------------------------------------
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
          error: "Connection not found or unauthorized"
        },
        { status: 404, headers: corsHeaders }
      );
    }

    // ------------------------------------
    // 3. Load tool schema (supports Rube, Gmail, OpenAI, any MCP)
    // ------------------------------------
    const { data: toolRecord } = await supabase
      .from("va_mcp_tools")
      .select("*")
      .eq("connection_id", connection_id)
      .eq("user_id", user_id)
      .eq("tool_name", tool_name)
      .single();

    const inputSchema =
      toolRecord?.parameters_schema &&
      typeof toolRecord.parameters_schema === "object" &&
      Object.keys(toolRecord.parameters_schema).length > 0
        ? toolRecord.parameters_schema
        : null;

    // ------------------------------------
    // 4. Normalize Arguments (all normalizer versions supported)
    // ------------------------------------
    const norm = normalizeMCPArguments({
      toolName: tool_name,
      rawArgs: parameters || {},
      schema: inputSchema
    });

    const normalized = norm.normalized ?? {};
    const missingRequired =
      norm.missingRequired ??
      norm.missing ??
      norm.requiredMissing ??
      [];

    if (missingRequired.length > 0) {
      return NextResponse.json(
        {
          success: false,
          error: `Missing required fields: ${missingRequired.join(", ")}`,
          tool: tool_name,
          normalized
        },
        { status: 400, headers: corsHeaders }
      );
    }

    // ------------------------------------
    // 5. Build JSON-RPC request
    // ------------------------------------
    const rpcBody = {
      jsonrpc: "2.0",
      id: `exec-${Date.now()}`,
      method: "tools/call",
      params: {
        name: tool_name,
        arguments: normalized
      }
    };

    // ------------------------------------
    // 6. Send request to MCP server
    // ------------------------------------
    const response = await fetch(conn.server_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(conn.api_key ? { Authorization: `Bearer ${conn.api_key}` } : {})
      },
      body: JSON.stringify(rpcBody)
    });

    const contentType = response.headers.get("content-type") || "";
    let json: any = null;

    // ------------------------------------
    // 7. SSE stream parsing (Rube uses SSE)
    // ------------------------------------
    if (contentType.includes("text/event-stream")) {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      let buffer = "";
      let lastJSON = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop()!; // keep incomplete last line

        for (const line of lines) {
          if (line.startsWith("data:")) {
            const raw = line.replace("data:", "").trim();
            try {
              lastJSON = JSON.parse(raw);
            } catch {
              // ignore invalid partials
            }
          }
        }
      }
      json = lastJSON ?? {};
    }

    // ------------------------------------
    // 8. JSON fallback
    // ------------------------------------
    else if (contentType.includes("application/json")) {
      json = await response.json().catch(() => null);
    }

    // ------------------------------------
    // 9. Unknown response format
    // ------------------------------------
    else {
      return NextResponse.json(
        {
          success: false,
          error: "Unknown response format from MCP server"
        },
        { status: 500, headers: corsHeaders }
      );
    }

    // ------------------------------------
    // 10. MCP returned HTTP error
    // ------------------------------------
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

    // ------------------------------------
    // 11. Auto-normalize Rube Multi-Execute results
    // ------------------------------------
    let resultPayload = json?.result ?? json;
    const isRubeMulti =
      tool_name === "RUBE_MULTI_EXECUTE_TOOL" &&
      resultPayload?.data?.data?.results;

    if (isRubeMulti) {
      resultPayload = {
        results: resultPayload.data.data.results,
        memory: resultPayload.data.data.memory,
        time_info: resultPayload.data.data.time_info
      };
    }

    // ------------------------------------
    // 12. Save execution log
    // ------------------------------------
    await supabase.from("va_mcp_logs").insert({
      user_id,
      connection_id,
      tool_name,
      raw_request: rpcBody,
      normalized_request: normalized,
      raw_response: resultPayload
    });

    // ------------------------------------
    // 13. Final Return
    // ------------------------------------
    return NextResponse.json(
      {
        success: true,
        tool: tool_name,
        normalized_args: normalized,
        result: resultPayload
      },
      { headers: corsHeaders }
    );
  } catch (e: any) {
    return NextResponse.json(
      {
        success: false,
        error: e.message || "Unexpected server error during MCP execution"
      },
      { status: 500, headers: corsHeaders }
    );
  }
}