"use server";

import { supabaseAdmin } from "@/lib/db";
import { corsHeaders, handleOptions } from "@/lib/cors";

export async function OPTIONS() {
  return handleOptions();
}

export async function POST(req: Request) {
  try {
    const { name, server_url, api_key, user_id } = await req.json();

    if (!name || !server_url || !api_key) {
      return new Response(JSON.stringify({
        success: false,
        error: "Missing required fields: name, server_url, api_key"
      }), {
        status: 400,
        headers: corsHeaders
      });
    }

    const { data, error } = await supabaseAdmin
      .from("va_mcp_connections")
      .insert({
        name,
        server_url,
        api_key
      })
      .select()
      .single();

    if (error) throw error;

    return new Response(JSON.stringify({
      success: true,
      connection_id: data.id
    }), {
      status: 200,
      headers: corsHeaders
    });

  } catch (err: any) {
    return new Response(JSON.stringify({
      success: false,
      error: err.message
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
}
