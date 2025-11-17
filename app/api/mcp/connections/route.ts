// app/api/mcp/connections/route.ts
import { supabaseAdmin } from "@/lib/db";

export async function POST(req: Request) {
  const { name, server_url, api_key, user_id } = await req.json();

  // TODO: auth check - verify user_id matches current session

  const { data, error } = await supabaseAdmin
    .from("mcp_connections")
    .insert({
      name,
      server_url,
      api_key,
      user_id
    })
    .select()
    .single();

  if (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }

  return Response.json({
    success: true,
    connection_id: data.id,
    name: data.name
  });
}
