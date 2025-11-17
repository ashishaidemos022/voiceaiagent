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
    const { name, server_url, api_key } = body;

    if (!server_url.startsWith("https://")) {
      return NextResponse.json(
        { success: false, error: "MCP server URL must start with https://" },
        { status: 400, headers: corsHeaders }
      );
    }

    const { data, error } = await supabase
      .from("mcp_connections")
      .insert({
        name,
        server_url,
        api_key,
        status: "pending"
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ success: true, connection: data }, { headers: corsHeaders });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500, headers: corsHeaders });
  }
}