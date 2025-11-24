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
    const body = await req.json();
    const { name, server_url, api_key, user_id } = body;

    // --- Input validation ---
    if (!user_id) {
      return NextResponse.json(
        { success: false, error: "Missing user_id (required)" },
        { status: 400, headers: corsHeaders }
      );
    }

    if (!server_url || typeof server_url !== "string") {
      return NextResponse.json(
        { success: false, error: "Missing or invalid MCP server_url" },
        { status: 400, headers: corsHeaders }
      );
    }

    if (!server_url.startsWith("https://")) {
      return NextResponse.json(
        { success: false, error: "MCP server URL must start with https://" },
        { status: 400, headers: corsHeaders }
      );
    }

    // --- Insert into Supabase ---
    const { data, error } = await supabase
      .from("va_mcp_connections")
      .insert({
        name,
        server_url,
        api_key,
        status: "pending",
        user_id
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json(
      { success: true, connection: data },
      { headers: corsHeaders }
    );
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: e.message ?? "Unexpected server error" },
      { status: 500, headers: corsHeaders }
    );
  }
}