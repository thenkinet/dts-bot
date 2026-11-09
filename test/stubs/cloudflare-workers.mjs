// Minimal stand-in for 'cloudflare:workers' so worker routes can be tested in Node.
export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
