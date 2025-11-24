// app/api/mcp/execute/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "@/lib/cors";
import { normalizeMCPArguments } from "@/lib/mcp-normalizer";
import { MCPToolDefinition } from "@/lib/mcp-normalizer";

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

    if (!connection_id || !tool_name || !user_id) {
      return NextResponse.json(
        { success: false, error: "Missing connection_id, tool_name, or user_id" },
        { status: 400, headers: corsHeaders }
      );
    }

    // ------------------------------------------------
    // 1. Validate connection
    // ------------------------------------------------
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

    // ------------------------------------------------
    // 2. Load tool metadata
    // ------------------------------------------------
    const { data: toolRecord } = await supabase
      .from("va_mcp_tools")
      .select("*")
      .eq("connection_id", connection_id)
      .eq("user_id", user_id)
      .eq("tool_name", tool_name)
      .single();

    const inputSchema =
      toolRecord?.parameters_schema &&
      Object.keys(toolRecord.parameters_schema).length > 0
        ? toolRecord.parameters_schema
        : undefined;

    // ------------------------------------------------
    // 3. Prepare MCPToolDefinition object
    // ------------------------------------------------
    const toolDef: MCPToolDefinition = {
      name: tool_name,
      inputSchema,
      input_schema: inputSchema
    };

    // ------------------------------------------------
    // 4. Normalize arguments using your universal normalizer
    // ------------------------------------------------
    const { normalized, logs } = normalizeMCPArguments(
      toolDef,
      parameters || {}
    );

    // Determine missing required fields
    const requiredFields =
      (inputSchema && Array.isArray(inputSchema.required)
        ? inputSchema.required
        : []) || [];

    const missingRequired = requiredFields.filter(
      (field: string) => normalized[field] == null
    );

    if (missingRequired.length > 0) {
      return NextResponse.json(
        {
          success: false,
          error: `Missing required fields: ${missingRequired.join(", ")}`,
          normalized,
          logs
        },
        { status: 400, headers: corsHeaders }
      );
    }

    // ------------------------------------------------
    // 5. Build MCP JSON-RPC call
    // ------------------------------------------------
    const rpcBody = {
      jsonrpc: "2.0",
      id: `exec-${Date.now()}`,
      method: "tools/call",
      params: {
        name: tool_name,
        arguments: normalized
      }
    };

    // ------------------------------------------------
    // 6. Execute request (SSE-aware)
    // ------------------------------------------------
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

    // ---- SSE ----
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
            try {
              lastJSON = JSON.parse(line.replace("data:", "").trim());
            } catch {}
          }
        }
      }

      json = lastJSON ?? {};
    }

    // ---- JSON ----
    else if (contentType.includes("application/json")) {
      json = await response.json().catch(() => null);
    }

    else {
      return NextResponse.json(
        { success: false, error: "Unknown MCP response format" },
        { status: 500, headers: corsHeaders }
      );
    }

    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          error: `HTTP ${response.status}`,
          normalized,
          response: json
        },
        { headers: corsHeaders }
      );
    }

    // ------------------------------------------------
    // 7. Rube-style multi-tool response normalization
    // ------------------------------------------------
    let result = json?.result ?? json;

    const isRubeMulti =
      tool_name === "RUBE_MULTI_EXECUTE_TOOL" &&
      result?.data?.data?.results;

    if (isRubeMulti) {
      result = {
        results: result.data.data.results,
        memory: result.data.data.memory ?? {},
        time_info: result.data.data.time_info ?? {}
      };
    }

    // ------------------------------------------------
    // 8. Save execution log
    // ------------------------------------------------
    await supabase.from("va_mcp_logs").insert({
      user_id,
      connection_id,
      tool_name,
      raw_request: rpcBody,
      normalized_request: normalized,
      raw_response: result
    });

    // ------------------------------------------------
    // 9. Done
    // ------------------------------------------------
    return NextResponse.json(
      {
        success: true,
        tool: tool_name,
        normalized_args: normalized,
        logs,
        result
      },
      { headers: corsHeaders }
    );
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message || "Server error during MCP execution" },
      { status: 500, headers: corsHeaders }
    );
  }
}