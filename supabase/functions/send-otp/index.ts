import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Load environment variables
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const RESEND_DOMAIN = Deno.env.get("RESEND_DOMAIN")!;
const OTP_EXPIRATION_TIME = Number(Deno.env.get("OTP_EXPIRATION_TIME")!);

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

const makeOtpTemplate = (otpCode: string): string => {
    return `
<div style="font-family: 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;min-width:1000px;overflow:auto;line-height:2">
    <div style="margin:50px auto;width:70%;padding:20px 0">
        <div style="border-bottom:1px solid #F7F9FC">
            <a href="" style="font-size:1.4em;color: #5A51FF;text-decoration:none;font-weight:600">Life Control</a>
        </div>
        <p>Quyidagi kod yordamida elektron pochtangizni tasdiqlang. Ushbu kod 10 daqiqada eskiradi. Kodni hech kimga bermang!</p>
        <h2 style="background: #5A51FF; margin: 0 auto; width: max-content; padding: 0 10px; color: #F7F9FC; border-radius: 4px;">${otpCode}</h2>
        <p style="font-size:0.9em;">Hurmat bilan<br />Life Control jamoasi</p>
        <hr style="border:none;border-top:1px solid #eee" />
        <div style="float:right;padding:8px 0;color:#aaa;font-size:0.8em;line-height:1;font-weight:300">
            <p>"Bog'bon XIRM" MChJ</p>
            <p>Farg'ona shahar, 84 uy</p>
        </div>
    </div>
</div>
`
}

const sendMail = async (_request: Request, target: string, code: string): Promise<Response> => {
    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${RESEND_API_KEY}`
        },
        body: JSON.stringify({
            from: RESEND_DOMAIN,
            to: target,
            subject: 'Tasdiqlash kodi',
            html: makeOtpTemplate(code),
        })
    });

    if (res.ok) {
        const data = await res.json();

        return new Response(
            JSON.stringify({ message: "Email sent successfully", data: data }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    } else {
        const errorData = await res.json();
        console.error("Resend error:", errorData);
        return new Response(
            JSON.stringify({ error: "Failed to send email" }), 
            { status: 500 },
        );
    }
};

serve(async (req) => {
    if (req.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
    }
    
    try {
        const { email, purpose } = await req.json();
        
        // Validate input
        if (!email || !purpose) {
            return new Response(JSON.stringify({ error: "Missing email or purpose" }), { status: 400 });
        }

        if (purpose === "signup") {
            // Check if user already exists
            // Find user by email
            const { data: usersData, error: listError } = await supabase.auth.admin.listUsers({ 
                filter: `email=eq.${email}` 
            });
            
            if (!listError && usersData.users.length > 0) {
                // User already exists
                return new Response(JSON.stringify({ error: "User already exists" }), { status: 400 });
            }
        }

        const now = new Date().toISOString();

        // Clean up expired OTPs for this email
        const { data: expiredOtps, error: cleanupError } = await supabase
            .from("otp_codes")
            .delete()
            .eq("email", email)
            .eq("purpose", purpose)
            .lt("expires_at", now);

        if (cleanupError) {
            console.error("Cleanup error:", cleanupError);
            // Continue processing even if cleanup fails
        }

        console.log(expiredOtps); 

        // Check how many active OTPs exist for this email
        const { data: activeOtps, error: countError } = await supabase
            .from("otp_codes")
            .select("id")
            .eq("email", email)
            .eq("purpose", purpose)
            .gte("expires_at", now);

        if (countError) {
            console.error("Count error:", countError);
            return new Response(JSON.stringify({ error: "Failed to check existing OTPs" }), { status: 500 });
        }

        // Rate limiting - maximum 3 active OTPs per email
        if (activeOtps && activeOtps.length >= 3) {
            return new Response(
                JSON.stringify({ 
                    error: "Too many attempts. Please wait before requesting another OTP." 
                }), 
                { status: 429 }
            );
        } 

        // Generate 6-digit OTP code
        // const code = Math.floor(100000 + Math.random() * 900000).toString();
        
        // Generate 4-digit OTP code
        const code = Math.floor(1000 + Math.random() * 9000).toString();
        const codeHash = await hashString(code);
        const expiresAt = new Date(Date.now() + OTP_EXPIRATION_TIME * 60 * 1000).toISOString();

        // Store in database
        const { error: dbError } = await supabase
            .from("otp_codes")
            .insert({ email, code_hash: codeHash, purpose, expires_at: expiresAt, created_at: now });
        
        if (dbError) {
            console.error("DB insert error:", dbError);
            return new Response(JSON.stringify({ error: "Failed to save OTP" }), { status: 500 });
        }

        // Send email via Resend
        const response = await sendMail(req, email, code);
        return response;

        // return new Response(JSON.stringify({ message: "OTP sent successfully" }), { status: 200 });

    } catch (err) {
        console.error(err);
        return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 });
    }
});