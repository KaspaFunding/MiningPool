import { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createGzip } from 'zlib';

// Rate limiting configuration
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 60; // 60 requests per minute
const clientRequests = new Map<string, { count: number; resetTime: number }>();

// Security headers
const securityHeaders = {
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' https://cdn.jsdelivr.net; img-src 'self' data:;",
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()'
};

// Cache configuration
const CACHE_DURATION = 3600; // 1 hour
const MAX_CACHE_SIZE = 1000; // Maximum number of cached items
const cache = new Map<string, { data: any; timestamp: number }>();

function rateLimit(ip: string): boolean {
    const now = Date.now();
    const clientData = clientRequests.get(ip) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW };

    if (now > clientData.resetTime) {
        clientData.count = 0;
        clientData.resetTime = now + RATE_LIMIT_WINDOW;
    }

    clientData.count++;
    clientRequests.set(ip, clientData);

    return clientData.count <= RATE_LIMIT_MAX_REQUESTS;
}

function validateInput(params: Record<string, string>): boolean {
    // Basic input validation
    for (const [key, value] of Object.entries(params)) {
        if (typeof value !== 'string' || value.length > 1000) {
            return false;
        }
        // Prevent SQL injection and XSS
        if (/[<>'"]/.test(value)) {
            return false;
        }
    }
    return true;
}

function getCachedData(key: string): any | null {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION * 1000) {
        return cached.data;
    }
    return null;
}

function setCachedData(key: string, data: any): void {
    // Check cache size and remove oldest entries if needed
    if (cache.size >= MAX_CACHE_SIZE) {
        const oldestKey = Array.from(cache.entries())
            .sort(([, a], [, b]) => a.timestamp - b.timestamp)[0][0];
        cache.delete(oldestKey);
    }
    cache.set(key, { data, timestamp: Date.now() });
}

// Clean up old entries periodically
setInterval(() => {
    const now = Date.now();
    // Clean rate limit entries
    for (const [ip, data] of clientRequests.entries()) {
        if (now > data.resetTime) {
            clientRequests.delete(ip);
        }
    }
    // Clean cache entries
    for (const [key, data] of cache.entries()) {
        if (now - data.timestamp > CACHE_DURATION * 1000) {
            cache.delete(key);
        }
    }
}, RATE_LIMIT_WINDOW);

export default class Server {
    private server: HttpServer;
    private io: SocketServer;
    public port: number;

    constructor(routes: Record<string, (params: any) => Promise<any>>, port: number) {
        this.port = port;
        this.server = new HttpServer();
        
        // Initialize Socket.IO only if needed
        if (process.env.ENABLE_WEBSOCKETS === 'true') {
            this.io = new SocketServer(this.server, {
                cors: {
                    origin: '*',
                    methods: ['GET', 'POST']
                }
            });
        }

        this.server.on('request', async (req, res) => {
            // Add security headers
            Object.entries(securityHeaders).forEach(([key, value]) => {
                res.setHeader(key, value);
            });

            // Add CORS headers
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

            // Handle preflight requests
            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }

            // Apply rate limiting
            const clientIp = req.socket.remoteAddress || 'unknown';
            if (!rateLimit(clientIp)) {
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Too many requests. Please try again later.' }));
                return;
            }

            // Handle static files with compression
            if (req.url === '/' || req.url === '/index.html') {
                try {
                    const html = readFileSync(join(__dirname, 'public', 'index.html'), 'utf-8');
                    const gzip = createGzip();
                    
                    gzip.on('error', (error) => {
                        console.error('Gzip error:', error);
                        if (!res.headersSent) {
                            res.writeHead(500);
                            res.end('Error compressing response');
                        }
                    });

                    res.setHeader('Content-Type', 'text/html');
                    res.setHeader('Content-Encoding', 'gzip');
                    gzip.pipe(res);
                    gzip.end(html);
                    return;
                } catch (error) {
                    console.error('Error serving index.html:', error);
                    if (!res.headersSent) {
                        res.writeHead(500);
                        res.end('Error loading page');
                    }
                    return;
                }
            }

            if (req.url === '/app.js') {
                try {
                    const js = readFileSync(join(__dirname, 'public', 'app.js'), 'utf-8');
                    const gzip = createGzip();
                    
                    gzip.on('error', (error) => {
                        console.error('Gzip error:', error);
                        if (!res.headersSent) {
                            res.writeHead(500);
                            res.end('Error compressing response');
                        }
                    });

                    res.setHeader('Content-Type', 'application/javascript');
                    res.setHeader('Content-Encoding', 'gzip');
                    gzip.pipe(res);
                    gzip.end(js);
                    return;
                } catch (error) {
                    console.error('Error serving app.js:', error);
                    if (!res.headersSent) {
                        res.writeHead(500);
                        res.end('Error loading script');
                    }
                    return;
                }
            }

            // Handle API routes
            const url = new URL(req.url!, `http://${req.headers.host}`);
            const route = routes[url.pathname];

            if (route) {
                try {
                    const params = Object.fromEntries(url.searchParams);
                    
                    // Validate input
                    if (!validateInput(params)) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Invalid input parameters' }));
                        return;
                    }

                    // Check cache
                    const cacheKey = `${url.pathname}?${url.searchParams.toString()}`;
                    const cachedData = getCachedData(cacheKey);
                    if (cachedData) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(cachedData));
                        return;
                    }

                    const result = await route(params);
                    setCachedData(cacheKey, result);
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                } catch (error) {
                    console.error(`Error handling route ${url.pathname}:`, error);
                    if (!res.headersSent) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ 
                            error: 'Internal server error',
                            message: error instanceof Error ? error.message : 'Unknown error'
                        }));
                    }
                }
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not found' }));
            }
        });

        // Error handling for the server
        this.server.on('error', (error) => {
            console.error('Server error:', error);
        });

        this.server.listen(port);
        console.log(`Server running on port ${port}`);
    }
}
