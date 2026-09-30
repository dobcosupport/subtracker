import { createClient } from "@supabase/supabase-js";
import { AdminApiError, getPasswordResetRedirect, jsonError } from "@/lib/server-admin";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { email?: string };
    const email = body.email?.trim() ?? "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return Response.json({ error: "Enter a valid email address." }, { status: 400 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) throw new AdminApiError("Supabase Auth is not configured.", 503);

    const auth = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { error } = await auth.auth.resetPasswordForEmail(email, { redirectTo: getPasswordResetRedirect() });
    if (error) throw error;

    return Response.json({ message: "If the account exists, a password reset email has been sent." });
  } catch (error) {
    return jsonError(error);
  }
}