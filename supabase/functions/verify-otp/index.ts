import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Load environment variables
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Initialize Supabase
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function hashString(otp: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(otp);
  
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  
    return hashHex;
}

serve(async (req) => {
    if (req.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
    }
    
    try {
        const { email, purpose, code, password } = await req.json();

        if (!email || !purpose || !code || !password) {
            return new Response(JSON.stringify({ error: "Missing parameters" }), { status: 400 });
        }

        const now = new Date().toISOString();

        // Lookup OTP record
        const { data, error: selectError } = await supabase
            .from("otp_codes")
            .select("id, code_hash, expires_at")
            .eq("email", email)
            .eq("purpose", purpose)
            .gt("expires_at", now)
            .order("expires_at", { ascending: false })
            .limit(1)
            .single();

        if (selectError || !data) {
            // Clean up expired OTPs for this email
            await supabase.from("otp_codes").delete().eq("email", email).eq("purpose", purpose);

            return new Response(JSON.stringify({ error: "Invalid or expired OTP" }), { status: 401 });
        }

        // Verify code
        const valid = (await hashString(code)) === data.code_hash;
        if (!valid) {
            return new Response(JSON.stringify({ error: "Invalid OTP code" }), { status: 401 });
        }

        let session;
        
        if (purpose === "signup") {

            // Create new user (email confirmed)
            const { error: createError } = await supabase.auth.admin.createUser({
                email,
                password,
                email_confirm: true,
            });
            
            if (createError) {
                return new Response(JSON.stringify({ error: createError.message }), { status: 400 });
            }

            // Sign in
            const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
            if (signInError) {
                return new Response(JSON.stringify({ error: signInError.message }), { status: 400 });
            }

            session = signInData.session;
        } else if (purpose === "reset") {
            // Find user by email
            const { data: usersData, error: listError } = await supabase.auth.admin.listUsers({ 
                filter: `email=eq.${email}` 
            });
            
            if (listError || !usersData.users.length) {

                // Clean up expired OTPs for this email
                await supabase.from("otp_codes").delete().eq("email", email).eq("purpose", purpose);

                return new Response(JSON.stringify({ error: "User not found" }), { status: 404 });
            }
            
            const user = usersData.users[0];
            
            // Update password
            const { error: updateError } = await supabase.auth.admin.updateUserById(user.id, { password });
            if (updateError) {
                return new Response(JSON.stringify({ error: updateError.message }), { status: 400 });
            }

            // Sign in
            const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
            if (signInError) {
                return new Response(JSON.stringify({ error: signInError.message }), { status: 400 });
            }

            // Clean up expired OTPs for this email
            await supabase.from("otp_codes").delete().eq("email", email).eq("purpose", purpose);

            session = signInData.session;
        } else {
            return new Response(JSON.stringify({ error: "Invalid purpose" }), { status: 400 });
        }

        return new Response(JSON.stringify({ session }), { status: 200 });
    } catch (err) {
        console.error(err);
        return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 });
    }
});