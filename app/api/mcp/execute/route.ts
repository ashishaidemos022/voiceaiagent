import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "@/lib/cors";
import { normalizeMCPArguments } from "@/lib/mcp-normalizer"; // your universal tool normalizer

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
    // 2. Validate connection belongs to user
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
    // 3. Load tool schema
    // ------------------------------------
    const { data: toolRecord } = await supabase
      .from("va_mcp_tools")
      .select("*")
      .eq("connection_id", connection_id)
      .eq("user_id", user_id)
      .eq("tool_name", tool_name)
      .single();

    const inputSchema =
      toolRecord?.parameters_schema && Object.keys(toolRecord.parameters_schema).length > 0
        ? toolRecord.parameters_schema
        : null;

    // ------------------------------------
    // 4. Normalize arguments using the universal MCP normalizer
    // ------------------------------------
    const { normalized, missingRequired } = normalizeMCPArguments({
      toolName: tool_name,
      rawArgs: parameters || {},
      schema: inputSchema
    });

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
    // 5. Execute via MCP server (HTTPS JSON-RPC)
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
    // 6. SSE Handling
    // ------------------------------------
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

    // ------------------------------------
    // 7. JSON handling
    // ------------------------------------
    else if (contentType.includes("application/json")) {
      json = await response.json().catch(() => null);
    } else {
      return NextResponse.json(
        {
          success: false,
          error: "Unknown response format from MCP server"
        },
        { status: 500, headers: corsHeaders }
      );
    }

    // MCP Request failed
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
    // 8. Normalize Rube multi-tool responses
    // ------------------------------------
    let resultPayload = json?.result ?? json;

    const isRubeMultiTool =
      tool_name === "RUBE_MULTI_EXECUTE_TOOL" &&
      resultPayload?.data?.data?.results;

    if (isRubeMultiTool) {
      resultPayload = {
        results: resultPayload.data.data.results,
        time_info: resultPayload.data.data.time_info,
        memory: resultPayload.data.data.memory
      };
    }

    // ------------------------------------
    // 9. Save execution log (optional)
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
    // 10. Final success response
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