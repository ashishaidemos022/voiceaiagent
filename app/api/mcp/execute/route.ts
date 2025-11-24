import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "@/lib/cors";
import { normalizeMCPArguments } from "@/lib/mcp-normalizer"; // Your final normalizer

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

    /* ----------------------------------------------------
       1. Validate required fields
    ---------------------------------------------------- */
    if (!connection_id || !tool_name || !user_id) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing required fields: connection_id, tool_name, user_id",
        },
        { status: 400, headers: corsHeaders }
      );
    }

    /* ----------------------------------------------------
       2. Validate connection belongs to the user
    ---------------------------------------------------- */
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

    /* ----------------------------------------------------
       3. Load tool schema from Supabase
    ---------------------------------------------------- */
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
        : null;

    /* ----------------------------------------------------
       4. Normalize arguments via universal normalizer
          (Your newest version: normalizeMCPArguments(tool, args))
    ---------------------------------------------------- */
    const norm = normalizeMCPArguments(
      {
        name: tool_name,
        inputSchema,
        input_schema: inputSchema,
      },
      parameters || {}
    );

    const normalized = norm.normalized;
    const logs = norm.logs;

    /* ----------------------------------------------------
       5. Build JSON-RPC request body
    ---------------------------------------------------- */
    const rpcBody = {
      jsonrpc: "2.0",
      id: `exec-${Date.now()}`,
      method: "tools/call",
      params: {
        name: tool_name,
        arguments: normalized,
      },
    };

    /* ----------------------------------------------------
       6. Call MCP server over JSON-RPC
    ---------------------------------------------------- */
    const response = await fetch(conn.server_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(conn.api_key ? { Authorization: `Bearer ${conn.api_key}` } : {}),
      },
      body: JSON.stringify(rpcBody),
    });

    const contentType = response.headers.get("content-type") || "";
    let json: any = null;

    /* ----------------------------------------------------
       7. Handle SSE (Rube uses SSE for multi-step tools)
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
              /* ignore partial chunks */
            }
          }
        }
      }

      json = lastJSON ?? {};
    }

    /* ----------------------------------------------------
       8. Handle normal JSON-RPC responses
    ---------------------------------------------------- */
    else if (contentType.includes("application/json")) {
      json = await response.json().catch(() => null);
    } else {
      return NextResponse.json(
        { success: false, error: "Unknown response format" },
        { status: 500, headers: corsHeaders }
      );
    }

    /* ----------------------------------------------------
       9. Error from MCP server
    ---------------------------------------------------- */
    if (!response.ok) {
      return NextResponse.json(
        { success: false, error: `HTTP ${response.status}`, response: json },
        { headers: corsHeaders }
      );
    }

    /* ----------------------------------------------------
       10. Rube multi-tool normalization
           Detect: RUBE_MULTI_EXECUTE_TOOL
    ---------------------------------------------------- */
    let resultPayload = json?.result ?? json;

    const isRubeMulti =
      tool_name === "RUBE_MULTI_EXECUTE_TOOL" &&
      resultPayload?.data?.data?.results;

    if (isRubeMulti) {
      resultPayload = {
        results: resultPayload.data.data.results,
        session: resultPayload.data.data.session,
        time_info: resultPayload.data.data.time_info,
        memory: resultPayload.data.data.memory,
      };
    }

    /* ----------------------------------------------------
       11. Save execution log
    ---------------------------------------------------- */
    await supabase.from("va_mcp_logs").insert({
      user_id,
      connection_id,
      tool_name,
      raw_request: rpcBody,
      normalized_request: normalized,
      raw_response: resultPayload,
      normalization_logs: logs,
    });

    /* ----------------------------------------------------
       12. Success
    ---------------------------------------------------- */
    return NextResponse.json(
      {
        success: true,
        tool: tool_name,
        normalized_args: normalized,
        normalization_logs: logs,
        result: resultPayload,
      },
      { headers: corsHeaders }
    );
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: e.message || "Unexpected server error" },
      { status: 500, headers: corsHeaders }
    );
  }
}