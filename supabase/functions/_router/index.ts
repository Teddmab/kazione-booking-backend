// Local dev router — mirrors the inline router that supabase functions serve
// generates in the edge runtime container. Routes /functions/v1/<name> to the
// matching function directory under /home/deno/functions/<name>/index.ts.

const FUNCTIONS_BASE = "/home/deno/functions";

Deno.serve({
  port: 8081,
  handler: async (req: Request) => {
    const url = new URL(req.url);

    if (url.pathname === "/_internal/health") {
      return new Response(JSON.stringify({ message: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const functionName = url.pathname.split("/").filter(Boolean)[0];
    if (!functionName) {
      return new Response(JSON.stringify({ error: "Function not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const servicePath = `${FUNCTIONS_BASE}/${functionName}`;
    const maybeEntrypoint = `file://${servicePath}/index.ts`;

    try {
      // @ts-ignore EdgeRuntime is global in the edge runtime environment
      const worker = await EdgeRuntime.userWorkers.create({
        servicePath,
        memoryLimitMb: 256,
        workerTimeoutMs: 30_000,
        noModuleCache: false,
        envVars: Object.entries(Deno.env.toObject()).filter(
          ([k]) => !["HOME", "HOSTNAME", "PATH", "PWD"].includes(k) && !k.startsWith("SUPABASE_INTERNAL_"),
        ),
        forceCreate: false,
        customModuleRoot: "",
        cpuTimeSoftLimitMs: 1000,
        cpuTimeHardLimitMs: 2000,
        maybeEntrypoint,
      });
      return await worker.fetch(req);
    } catch (e) {
      console.error(`[router] function ${functionName} error:`, e);
      return new Response(
        JSON.stringify({ error: { code: "INTERNAL_ERROR", message: String(e) } }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  },
});
