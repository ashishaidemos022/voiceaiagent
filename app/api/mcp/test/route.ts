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
    const { connection_id, mcp_session_id } = await req.json();

    if (!connection_id) {
      return NextResponse.json(
        { success: false, error: "connection_id is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    // 1) Load MCP connection config from Supabase
    const { data: conn, error: connError } = await supabase
      .from("va_mcp_connections")
      .select("*")
      .eq("id", connection_id)
      .single();

    if (connError) {
      return NextResponse.json(
        { success: false, error: connError.message },
        { status: 500, headers: corsHeaders }
      );
    }

    if (!conn) {
      return NextResponse.json(
        { success: false, error: "Connection not found" },
        { status: 404, headers: corsHeaders }
      );
    }

    // 2) Derive / generate MCP session id
    // Use a stable ID per connection if none provided by client
    const incomingSessionId =
      req.headers.get("mcp-session-id") ||
      req.headers.get("Mcp-Session-Id") ||
      mcp_session_id ||
      undefined;
    const sessionId = incomingSessionId ?? undefined;

    // 3) Call MCP server with INITIALIZE (required first step in MCP lifecycle)
    const initBody = {
      jsonrpc: "2.0",
      id: "initialize-1",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26", // or "2024-11-05" if your server only supports that
        capabilities: {
          // minimal client capabilities; adjust if you support more
          roots: {},
          sampling: {},
        },
        clientInfo: {
          name: "va-mcp-proxy",
          version: "0.1.0",
        },
      },
    };

    const response = await fetch(conn.server_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
        ...(conn.api_key ? { Authorization: `Bearer ${conn.api_key}` } : {}),
      },
      body: JSON.stringify(initBody),
    });

    const contentType = response.headers.get("content-type") || "";
    let json: any = null;
    let rawText: string | null = null;

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
            if (!raw || raw === "[DONE]") continue;
            try {
              lastJSON = JSON.parse(raw);
            } catch {
              // ignore malformed chunks
            }
          }
        }
      }

      json = lastJSON ?? {};
    } else if (contentType.includes("application/json")) {
      json = await response.json().catch(() => null);
    } else {
      // Fallback: some servers omit or mislabel content-type
      rawText = await response.text().catch(() => "");
      if (rawText) {
        try {
          json = JSON.parse(rawText);
        } catch {
          // keep rawText for error payloads below
        }
      }
    }

    if (!json && rawText) {
      return NextResponse.json(
        {
          success: false,
          error: "MCP server returned non-JSON response",
          raw: rawText.slice(0, 500)
        },
        { status: 200, headers: corsHeaders }
      );
    }

    if (!json) {
      return NextResponse.json(
        { success: false, error: "MCP server returned empty response" },
        { status: 200, headers: corsHeaders }
      );
    }
    const returnedSessionId =
      response.headers.get("Mcp-Session-Id") ||
      response.headers.get("mcp-session-id") ||
      sessionId;

    // If HTTP error, surface it
    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          error: `HTTP ${response.status}`,
          response: json,
        },
        { status: 200, headers: corsHeaders }
      );
    }

    // If MCP JSON-RPC error, surface that too
    if (json?.error) {
      return NextResponse.json(
        {
          success: false,
          error: json.error.message || "MCP initialization error",
          code: json.error.code,
          response: json,
        },
        { status: 200, headers: corsHeaders }
      );
    }

    const tryParseJSON = (input: string) => {
      const trimmed = input.trim();
      if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
        return null;
      }
      try {
        return JSON.parse(trimmed);
      } catch {
        return null;
      }
    };

    let result = json?.result ?? json;

    // OpenAI Agent Builder-style tool output: { content: [{ type: "text", text: "..." }] }
    const contentBlocks = result?.content ?? json?.content;
    if (Array.isArray(contentBlocks)) {
      const textParts = contentBlocks
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text);

      if (textParts.length > 0) {
        const combined = textParts.join("");
        const parsed = tryParseJSON(combined);
        result = parsed ?? { content: combined };
      }
    }

    // 3b) Notify server that initialization is complete (required by some MCP servers)
    if (returnedSessionId) {
      await fetch(conn.server_url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Mcp-Session-Id": returnedSessionId,
          ...(conn.api_key ? { Authorization: `Bearer ${conn.api_key}` } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "initialized",
        }),
      }).catch(() => null);
    }

    // 4) Optionally mark connection as active if initialization succeeded
    await supabase
      .from("va_mcp_connections")
      .update({
        status: "active",
        last_health_check: new Date().toISOString(),
      })
      .eq("id", connection_id);

    // 5) Return success + upstream response
    return NextResponse.json(
      {
        success: true,
        response: result ?? json,
        mcp_session_id: returnedSessionId,
      },
      { headers: corsHeaders }
    );
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: e.message || "Unexpected error" },
      { status: 500, headers: corsHeaders }
    );
  }
}
