/**
 * Edge Provider Function: /api/server-cancel
 * 
 * Cancels a job by updating its status to 'CANCELLED' in the D1 database.
 */

export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
            "Access-Control-Max-Age": "86400"
        }
    });
}

export async function onRequestPost(context) {
    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
        "Content-Type": "application/json",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0"
    };

    try {
        const { request, env } = context;
        
        // Handle auth matching server-relay.js
        const expectedApiKey = (env?.API_KEY || "").trim();
        if (expectedApiKey) {
            const authHeader = request.headers.get("Authorization") || "";
            const xApiKey = request.headers.get("X-API-Key") || "";
            let clientToken = xApiKey.trim();
            if (!clientToken && authHeader) {
                const parts = authHeader.trim().split(/\s+/);
                clientToken = (parts.length === 2 && parts[0].toLowerCase() === "bearer") ? parts[1] : authHeader.trim();
            }
            if (clientToken !== expectedApiKey) {
                return new Response(JSON.stringify({ success: false, error: "Unauthorized: Invalid API Key" }), { status: 401, headers: corsHeaders });
            }
        }

        const url = new URL(request.url);
        let jobId = url.searchParams.get("jobId");
        
        if (!jobId) {
            const body = await request.json().catch(() => ({}));
            jobId = body.jobId;
        }

        if (!jobId) {
            return new Response(JSON.stringify({ success: false, error: "Missing jobId" }), { status: 400, headers: corsHeaders });
        }

        if (!env.DB) {
             return new Response(JSON.stringify({ success: false, error: "D1 Database 'DB' is not bound" }), { status: 500, headers: corsHeaders });
        }

        // Garbage collection: Auto-delete jobs older than 12 hours
        context.waitUntil(
            env.DB.prepare("DELETE FROM Jobs WHERE created_at < ?").bind(Date.now() - 12 * 60 * 60 * 1000).run().catch(() => {})
        );

        // Fetch existing payload
        const stmt = await env.DB.prepare("SELECT payload FROM Jobs WHERE job_id = ?").bind(jobId).first();
        if (stmt && stmt.payload) {
            const existing = JSON.parse(stmt.payload);
            const updated = {
                ...existing,
                status: "CANCELLED",
                stage: "CANCELLED",
                updatedAt: Date.now()
            };
            
            // Update the payload in D1
            await env.DB.prepare("UPDATE Jobs SET payload = ? WHERE job_id = ?")
                .bind(JSON.stringify(updated), jobId)
                .run();
        }

        return new Response(JSON.stringify({ success: true, message: "Job marked as cancelled" }), { status: 200, headers: corsHeaders });

    } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: corsHeaders });
    }
}
